import type { ComputeTarget, ComputeTargetDetails, ShareableProject } from '@mmt/contracts';
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
  listShareableProjects,
  listTargetProjects,
  replaceTargetProjects,
  targetUsableSql,
} from '../repositories/computeTargetSharingRepository.js';
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
  personal?: boolean;
  projectIds?: string[];
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

// Only owned computers have Projects to share with.
function targetNotOwned(): never {
  throw new DomainError(
    422,
    '全体の計算機はどのProjectからも使えるので、共有先を選びません',
    'target_not_owned',
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
   * Global computers, one's own, and those shared with a Project one is a member of; with
   * `projectId`, only those one may use in that Project (where Jobs are created).
   */
  async list(principal: Principal, query: { projectId?: string } = {}): Promise<ComputeTargetDetails[]> {
    requireScope(principal, 'read');
    if (query.projectId)
      await requireProject(this.database, principal, {
        projectId: query.projectId,
        role: 'viewer',
        scope: 'read',
      });
    const everything = principal.user.isAdmin && principal.method === 'session' && !query.projectId;
    const targets = await rows<TargetRow>(
      this.database,
      `${targetSelect} WHERE $1::boolean OR ${targetUsableSql('$2::uuid', '$3::uuid')} ORDER BY t.name,t.id`,
      [everything, principal.user.id, query.projectId ?? null],
    );
    return this.details(this.database, principal, targets);
  }

  async create(
    principal: Principal,
    request: TargetCreateRequest,
    metadata: RequestMetadata,
  ): Promise<ComputeTargetDetails> {
    const { site, personal: personalRequest, projectIds = [], jobShell, ...fields } = request;
    const administrator = isGlobalAdministrator(principal);
    const personal = personalRequest ?? !administrator;
    if (!administrator) {
      requireSession(principal, '計算機の追加');
      if (!personal || fields.executor !== 'site')
        throw new DomainError(
          403,
          '全体管理者でない人が足せるのは、自分の計算機（site）だけです',
          'target_admin_required',
        );
    }
    // A site's runner downloads inputs itself with the Job token; ssh/local relay through the worker.
    const input = {
      ...fields,
      datasetTransfer: fields.datasetTransfer ?? (fields.executor === 'site' ? 'direct' : 'relay'),
    };
    validateTargetConfiguration(input, this.config.allowLocalExecutor);
    if (input.executor !== 'site' && (site || personal || projectIds.length || jobShell))
      siteOnly('全体設定・所有者・共有・job shellはsiteだけの設定です');
    if (!personal && projectIds.length) targetNotOwned();
    const settings = mergeSiteSettings(DEFAULT_SITE_SETTINGS, site ?? {});
    if (input.executor === 'site') validateSiteSettings(input, settings);
    return transaction(this.database, async (connection) => {
      if (input.executor === 'site') await this.assertLauncher(connection, input, settings);
      const target = (await first<ComputeTarget>(
        connection,
        `INSERT INTO compute_targets(name,host,port,username,ssh_key_path,known_hosts_path,work_directory,python_executable,gpu_ids,max_concurrent_jobs,enabled,executor,runtime_kinds,dataset_cache_max_bytes,dataset_transfer,
          submission_mode,cpu_arch,supports_array,queue_timeout_seconds,owner_user_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING *`,
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
          personal ? principal.user.id : null,
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
        await this.share(connection, { target, projectIds, sharedBy: principal.user.id });
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
          personal,
          projectIds,
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
        await requireTargetManager(connection, principal, target);
        const updated = { ...target, ...input };
        validateTargetConfiguration(updated, this.config.allowLocalExecutor);
        if (target.ownerUserId && updated.executor !== 'site')
          siteOnly('自分の計算機はsiteのままです');
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
          queue_timeout_seconds=$20
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
          ],
        );
        // Settings are checked when they or the submission mode change, so an older site that has
        // not been filled in yet can still be switched off.
        if (updated.executor === 'site' && (site || updated.submissionMode !== target.submissionMode))
          await this.updateSite(connection, principal, { target: updated, site });
        await writeAuditEvent(connection, { ...draft, outcome: 'success' });
        return this.detail(connection, principal, targetId);
      }),
    );
  }

  /** PUT /targets/:id/projects: the Projects whose members may use an owned computer. */
  async replaceProjects(
    principal: Principal,
    targetId: string,
    sharing: { projectIds: string[]; metadata: RequestMetadata },
  ): Promise<ComputeTargetDetails> {
    const draft: AuditEventDraft = {
      ...auditActor(principal),
      ...sharing.metadata,
      action: 'compute_target.share',
      resourceType: 'compute_target',
      resourceId: targetId,
      details: { projectIds: sharing.projectIds },
    };
    return recordDenial(this.database, draft, () =>
      transaction(this.database, async (connection) => {
        const target = await findTarget(connection, targetId, { lock: true });
        await requireTargetManager(connection, principal, target);
        if (!target.ownerUserId) targetNotOwned();
        await this.share(connection, { target, projectIds: sharing.projectIds, sharedBy: principal.user.id });
        await writeAuditEvent(connection, { ...draft, outcome: 'success' });
        return this.detail(connection, principal, targetId);
      }),
    );
  }

  /**
   * GET /targets/shareable-projects: the projectIds POST /targets accepts for a computer of one's
   * own, for whoever may add one (a browser session, or a global administrator's admin token). A
   * global administrator sees every Project but shares only with those they are a member of.
   */
  async ownShareableProjects(principal: Principal): Promise<ShareableProject[]> {
    if (!isGlobalAdministrator(principal)) requireSession(principal, '計算機の追加');
    return listShareableProjects(this.database, principal.user.id);
  }

  /**
   * GET /targets/:id/shareable-projects: what PUT /targets/:id/projects accepts. They are the
   * owner's Projects, so a global administrator editing someone else's computer is offered
   * those rather than their own.
   */
  async shareableProjects(principal: Principal, targetId: string): Promise<ShareableProject[]> {
    requireScope(principal, 'read');
    const target = await findTarget(this.database, targetId);
    await requireTargetManager(this.database, principal, target);
    if (!target.ownerUserId) targetNotOwned();
    return listShareableProjects(this.database, target.ownerUserId);
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

  // Accepts exactly what ownShareableProjects (a new computer) and shareableProjects list.
  private async share(
    connection: Connection,
    sharing: { target: ComputeTarget; projectIds: string[]; sharedBy: string },
  ): Promise<void> {
    const { target, projectIds } = sharing;
    if (!target.ownerUserId) return;
    const shareable = new Set(
      (await listShareableProjects(connection, target.ownerUserId)).map((project) => project.id),
    );
    if (!projectIds.every((projectId) => shareable.has(projectId)))
      throw new DomainError(
        422,
        '共有できるのは、計算機の所有者がeditor以上のProjectだけです',
        'target_project_forbidden',
      );
    await replaceTargetProjects(connection, {
      targetId: target.id,
      projectIds,
      createdBy: sharing.sharedBy,
    });
  }

  private async detail(
    connection: Connection,
    principal: Principal,
    targetId: string,
  ): Promise<ComputeTargetDetails> {
    const target = (await first<TargetRow>(connection, `${targetSelect} WHERE t.id=$1`, [targetId]))!;
    return (await this.details(connection, principal, [target]))[0]!;
  }

  // Settings and sharing are their manager's; everyone else sees what the computer is and whose
  // account its Jobs run as.
  private async details(
    connection: Connection,
    principal: Principal,
    targets: TargetRow[],
  ): Promise<ComputeTargetDetails[]> {
    const settings = await listSiteSettings(
      connection,
      targets.filter((target) => target.executor === 'site').map((target) => target.id),
    );
    const projects = await listTargetProjects(
      connection,
      targets.filter((target) => isTargetManager(principal, target)).map((target) => target.id),
    );
    const fullView = principal.user.isAdmin && principal.method === 'session';
    return targets.map((target) => {
      const managedHere = isTargetManager(principal, target);
      return {
        ...(fullView ? target : withoutConnection(target)),
        projectIds: managedHere ? (projects.get(target.id) ?? []) : [],
        site: managedHere ? (settings.get(target.id) ?? null) : null,
        siteAccountMode: settings.get(target.id)?.accountMode ?? null,
      };
    });
  }
}
