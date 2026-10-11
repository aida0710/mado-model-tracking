import type { ComputeTarget, ComputeTargetDetails, ComputeTargetOverview } from '@mmt/contracts';
import type { Principal } from '../auth/principal.js';
import type { ApiConfig } from '../config.js';
import { first, rows, transaction, type Connection, type Database } from '../db/database.js';
import { conflict, DomainError, notFound } from '../domain/errors.js';
import {
  DEFAULT_SITE_SETTINGS,
  mergeSiteSettings,
  validateSiteSettings,
  type SiteSettingsInputValues,
  type SiteSettingsValues,
} from '../domain/siteSettingsValidation.js';
import {
  hasTargetExecutionChanges,
  validateTargetConfiguration,
} from '../domain/targetConfiguration.js';
import type { TargetCreate, TargetPatch } from '../domain/validation.js';
import type { RequestMetadata } from '../http/requestMetadata.js';
import { writeAuditEvent } from '../repositories/auditRepository.js';
import {
  listTargetOverviewRows,
  targetUsableSql,
} from '../repositories/computeTargetAccessRepository.js';
import { isLiveLauncher } from '../repositories/launcherRepository.js';
import { insertJobShell } from '../repositories/siteJobShellRepository.js';
import { reconcileSiteKeys } from '../repositories/siteKeyRepository.js';
import {
  findSiteSettings,
  listSiteSettings,
  lockSiteSettings,
  saveSiteSettings,
  siteSettingsValues,
} from '../repositories/siteSettingsRepository.js';
import { requireProject, requireScope } from './accessService.js';
import { auditActor, recordDenial, type AuditEventDraft } from './auditService.js';
import { isGlobalAdministrator, isTargetManager, requireTargetManager } from './siteAccess.js';
import { submissionCountSql } from './siteJobEnding.js';
import { requireSession } from './tokenService.js';

export interface TargetCreateRequest extends TargetCreate {
  site?: SiteSettingsInputValues;
  jobShell?: string;
}
export interface TargetPatchRequest extends TargetPatch {
  site?: SiteSettingsInputValues;
}

type TargetRow = ComputeTarget & { ownerName: string | null };

const targetSelect =
  'SELECT t.*,o.display_name AS owner_name FROM compute_targets t LEFT JOIN users o ON o.id=t.owner_user_id';

// Host and SSH file paths are infrastructure details; workers receive full targets only after claim.
function withoutConnection(target: TargetRow): TargetRow {
  return {
    ...target,
    host: '',
    username: '',
    sshKeyPath: '',
    knownHostsPath: '',
    workDirectory: '',
    pythonExecutable: '',
  };
}

function siteOnly(message: string): never {
  throw new DomainError(422, message, 'site_only_setting');
}

// ssh and local targets reach hosts through the workers' own SSH keys, so only global
// administrators add or keep them; everyone else adds sites.
function targetAdminRequired(): never {
  throw new DomainError(
    403,
    '全体管理者でない人が持てるコンピュータはsiteだけです',
    'target_admin_required',
  );
}

// A private computer serves its owner, so one from before owners must stay public.
function ownerRequiredForPrivate(): never {
  throw new DomainError(
    422,
    '所有者のいないコンピュータはPrivateにできません',
    'target_owner_missing',
  );
}

async function findTarget(
  connection: Connection,
  targetId: string,
  options: { lock?: boolean } = {},
): Promise<ComputeTarget> {
  const target = await first<ComputeTarget>(
    connection,
    `SELECT * FROM compute_targets WHERE id=$1${options.lock ? ' FOR UPDATE' : ''}`,
    [targetId],
  );
  if (!target) notFound('ComputeTarget');
  return target;
}

export class TargetService {
  constructor(
    private readonly database: Database,
    private readonly config: ApiConfig,
  ) {}

  /**
   * The computers one may use (public ones, one's own, and one's creator's for a Service Account)
   * and those one manages (one's own; every computer for a global administrator). With
   * `projectId`, only those one may use, for the screens that create Jobs in that Project.
   */
  async list(principal: Principal, query: { projectId?: string } = {}): Promise<ComputeTargetDetails[]> {
    requireScope(principal, 'read');
    if (query.projectId)
      await requireProject(this.database, principal, {
        projectId: query.projectId,
        role: 'viewer',
        scope: 'read',
      });
    const includeManaged = !query.projectId;
    const targets = await rows<TargetRow>(
      this.database,
      `${targetSelect} WHERE ${targetUsableSql('$1::uuid')}
        OR ($2::boolean AND (t.owner_user_id=$1 OR $3::boolean)) ORDER BY t.name,t.id`,
      [principal.user.id, includeManaged, isGlobalAdministrator(principal)],
    );
    return this.details(this.database, principal, targets);
  }

  /**
   * GET /targets/overview: every computer with whether one may use and manage it, and nothing of
   * how it is reached, so someone else's private computer is seen but not described.
   */
  async overview(principal: Principal): Promise<ComputeTargetOverview[]> {
    requireScope(principal, 'read');
    const found = await listTargetOverviewRows(this.database, principal.user.id);
    return found.map(({ launcherName, launcherLastSeenAt, launcherRevokedAt, ...target }) => ({
      ...target,
      canManage: isTargetManager(principal, target),
      launcher:
        launcherName === null
          ? null
          : { name: launcherName, lastSeenAt: launcherLastSeenAt, revoked: launcherRevokedAt !== null },
    }));
  }

  async create(
    principal: Principal,
    request: TargetCreateRequest,
    metadata: RequestMetadata,
  ): Promise<ComputeTargetDetails> {
    const { site, jobShell, ...fields } = request;
    if (!isGlobalAdministrator(principal)) {
      requireSession(principal, 'コンピュータの追加');
      if (fields.executor !== 'site') targetAdminRequired();
    }
    // A site's runner downloads inputs itself with the Job token; ssh/local relay through the worker.
    const input = {
      ...fields,
      datasetTransfer: fields.datasetTransfer ?? (fields.executor === 'site' ? 'direct' : 'relay'),
    };
    validateTargetConfiguration(input, this.config.allowLocalExecutor);
    if (input.executor !== 'site' && (site || jobShell))
      siteOnly('全体設定・job shellはsiteだけの設定です');
    const settings = mergeSiteSettings(DEFAULT_SITE_SETTINGS, site ?? {});
    if (input.executor === 'site') validateSiteSettings(input, settings);
    return transaction(this.database, async (connection) => {
      if (input.executor === 'site') await this.assertLauncher(connection, input, settings);
      const target = (await first<ComputeTarget>(
        connection,
        `INSERT INTO compute_targets(name,host,port,username,ssh_key_path,known_hosts_path,work_directory,python_executable,gpu_ids,max_concurrent_jobs,enabled,executor,runtime_kinds,dataset_cache_max_bytes,dataset_transfer,
          submission_mode,cpu_arch,supports_array,queue_timeout_seconds,owner_user_id,visibility)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21) RETURNING *`,
        [
          input.name,
          input.host,
          input.port,
          input.username,
          input.sshKeyPath,
          input.knownHostsPath,
          input.workDirectory,
          input.pythonExecutable,
          input.gpuIds,
          input.maxConcurrentJobs,
          input.enabled,
          input.executor,
          input.runtimeKinds,
          input.datasetCacheMaxBytes,
          input.datasetTransfer,
          input.submissionMode,
          input.cpuArch,
          input.supportsArray,
          input.queueTimeoutSeconds,
          // Whoever adds a computer owns it, a global administrator's ssh or local target too.
          principal.user.id,
          input.visibility,
        ],
      ))!;
      let jobShellVersion: number | null = null;
      if (target.executor === 'site') {
        await saveSiteSettings(connection, { targetId: target.id, settings, updatedBy: principal.user.id });
        if (jobShell)
          jobShellVersion = (
            await insertJobShell(connection, {
              targetId: target.id,
              content: jobShell,
              createdBy: principal.user.id,
            })
          ).version;
        await reconcileSiteKeys(connection, {
          targetId: target.id,
          automatic: target.submissionMode === 'automatic',
          settings,
        });
      }
      await writeAuditEvent(connection, {
        ...auditActor(principal),
        ...metadata,
        action: 'compute_target.create',
        outcome: 'success',
        resourceType: 'compute_target',
        resourceId: target.id,
        details: {
          name: target.name,
          executor: target.executor,
          submissionMode: target.submissionMode,
          visibility: target.visibility,
          jobShellVersion,
        },
      });
      return this.detail(connection, principal, target.id);
    });
  }

  async patch(
    principal: Principal,
    targetId: string,
    request: TargetPatchRequest,
    metadata: RequestMetadata,
  ): Promise<ComputeTargetDetails> {
    const { site, ...input } = request;
    const draft: AuditEventDraft = {
      ...auditActor(principal),
      ...metadata,
      action: 'compute_target.update',
      resourceType: 'compute_target',
      resourceId: targetId,
      details: { fields: Object.keys(input), siteFields: Object.keys(site ?? {}) },
    };
    return recordDenial(this.database, draft, () =>
      transaction(this.database, async (connection) => {
        const target = await findTarget(connection, targetId, { lock: true });
        requireTargetManager(principal, target);
        const updated = { ...target, ...input };
        validateTargetConfiguration(updated, this.config.allowLocalExecutor);
        if (!isGlobalAdministrator(principal) && updated.executor !== 'site') targetAdminRequired();
        if (updated.visibility === 'private' && !updated.ownerUserId) ownerRequiredForPrivate();
        if (site && updated.executor !== 'site') siteOnly('全体設定はsiteだけの設定です');
        const occupancy = (await first<{ pending: number; active: number }>(
          connection,
          `SELECT count(*)::int AS pending,
            ${submissionCountSql('$2', " FILTER(WHERE status IN ('claimed','running'))")} AS active
          FROM jobs WHERE target_id=$1 AND status IN ('queued','claimed','running')`,
          [targetId, target.supportsArray],
        ))!;
        if (occupancy.pending && hasTargetExecutionChanges(target, updated))
          conflict('未完了JobがあるComputeTargetの実行設定は変更できません');
        if (updated.maxConcurrentJobs < occupancy.active)
          conflict('同時実行数を実行中Jobの数より小さくできません');
        await connection.query(
          `UPDATE compute_targets SET name=$2,host=$3,port=$4,username=$5,ssh_key_path=$6,known_hosts_path=$7,
          work_directory=$8,python_executable=$9,gpu_ids=$10,max_concurrent_jobs=$11,enabled=$12,executor=$13,runtime_kinds=$14,
          dataset_cache_max_bytes=$15,dataset_transfer=$16,submission_mode=$17,cpu_arch=$18,supports_array=$19,
          queue_timeout_seconds=$20,visibility=$21
          WHERE id=$1`,
          [
            targetId,
            updated.name,
            updated.host,
            updated.port,
            updated.username,
            updated.sshKeyPath,
            updated.knownHostsPath,
            updated.workDirectory,
            updated.pythonExecutable,
            updated.gpuIds,
            updated.maxConcurrentJobs,
            updated.enabled,
            updated.executor,
            updated.runtimeKinds,
            updated.datasetCacheMaxBytes,
            updated.datasetTransfer,
            updated.submissionMode,
            updated.cpuArch,
            updated.supportsArray,
            updated.queueTimeoutSeconds,
            updated.visibility,
          ],
        );
        // Settings are checked when they or the submission mode change, so an older site that has
        // not been filled in yet can still be switched off.
        if (updated.executor === 'site' && (site || updated.submissionMode !== target.submissionMode))
          await this.updateSite(connection, principal, { target: updated, site });
        // Who opened a private computer to everyone, or closed a public one, is worth finding.
        await writeAuditEvent(connection, {
          ...draft,
          outcome: 'success',
          details: {
            ...draft.details,
            ...(updated.visibility !== target.visibility && {
              visibility: { from: target.visibility, to: updated.visibility },
            }),
          },
        });
        return this.detail(connection, principal, targetId);
      }),
    );
  }

  private async updateSite(
    connection: Connection,
    principal: Principal,
    change: { target: ComputeTarget; site: SiteSettingsInputValues | undefined },
  ): Promise<void> {
    const { target } = change;
    await lockSiteSettings(connection, target.id);
    const stored = await findSiteSettings(connection, target.id);
    const settings = mergeSiteSettings(
      stored ? siteSettingsValues(stored) : DEFAULT_SITE_SETTINGS,
      change.site ?? {},
    );
    validateSiteSettings(target, settings);
    await this.assertLauncher(connection, target, settings);
    await saveSiteSettings(connection, { targetId: target.id, settings, updatedBy: principal.user.id });
    await reconcileSiteKeys(connection, {
      targetId: target.id,
      automatic: target.submissionMode === 'automatic',
      settings,
    });
  }

  private async assertLauncher(
    connection: Connection,
    target: Pick<ComputeTarget, 'submissionMode'>,
    settings: SiteSettingsValues,
  ): Promise<void> {
    if (target.submissionMode !== 'automatic' || !settings.launcherId) return;
    if (!(await isLiveLauncher(connection, settings.launcherId)))
      throw new DomainError(422, '選んだlauncherはありません（失効しています）', 'site_launcher_invalid');
  }

  private async detail(
    connection: Connection,
    principal: Principal,
    targetId: string,
  ): Promise<ComputeTargetDetails> {
    const target = (await first<TargetRow>(connection, `${targetSelect} WHERE t.id=$1`, [targetId]))!;
    return (await this.details(connection, principal, [target]))[0]!;
  }

  // Settings are their manager's; everyone else who may use a computer sees what it is and whose
  // account its Jobs run as. How an ssh or local target is reached is shown in a browser session.
  private async details(
    connection: Connection,
    principal: Principal,
    targets: TargetRow[],
  ): Promise<ComputeTargetDetails[]> {
    const settings = await listSiteSettings(
      connection,
      targets.filter((target) => target.executor === 'site').map((target) => target.id),
    );
    return targets.map((target) => {
      const managedHere = isTargetManager(principal, target);
      return {
        ...(managedHere && principal.method === 'session' ? target : withoutConnection(target)),
        site: managedHere ? (settings.get(target.id) ?? null) : null,
        siteAccountMode: settings.get(target.id)?.accountMode ?? null,
      };
    });
  }
}
