import type {
  ComputeTarget,
  JsonObject,
  Launcher,
  LauncherConfiguration,
  LauncherCreated,
  SiteKey,
} from '@mmt/contracts';
import type { Principal } from '../auth/principal.js';
import { first, rows, transaction, type Connection, type Database } from '../db/database.js';
import { DomainError, notFound } from '../domain/errors.js';
import { parseSshPublicKey } from '../domain/sshPublicKey.js';
import type { RequestMetadata } from '../http/requestMetadata.js';
import { writeAuditEvent } from '../repositories/auditRepository.js';
import {
  findLauncher,
  findLauncherByUser,
  insertLauncher,
  LAUNCHER_SCOPE,
  listLaunchers,
  replaceLauncherToken,
  revokeLauncher,
  touchLauncher,
} from '../repositories/launcherRepository.js';
import {
  finishConnectionCheck,
  listLauncherConnectionChecks,
} from '../repositories/siteConnectionCheckRepository.js';
import { findCurrentJobShell } from '../repositories/siteJobShellRepository.js';
import { listLauncherKeys, publishSiteKey } from '../repositories/siteKeyRepository.js';
import { listLauncherSiteSettings } from '../repositories/siteSettingsRepository.js';
import { requireGlobalAdmin, requireScope } from './accessService.js';
import { auditActor } from './auditService.js';
import { isGlobalAdministrator } from './siteAccess.js';
import { resolveSubmissionAccount } from './siteReadiness.js';

/** The launcher a request comes from, by its token. */
export interface LauncherIdentity {
  launcherId: string;
  launcherName: string;
  tokenId: string;
}

/**
 * Only a live launcher's own token reaches the launcher endpoints. Its user is no Project's
 * member, so the same token reaches nothing else.
 */
export async function requireLauncher(
  connection: Connection,
  principal: Principal,
): Promise<LauncherIdentity> {
  const token = principal.token;
  const launcher =
    principal.method === 'token' &&
    token &&
    !token.job &&
    !token.projectId &&
    token.scopes.includes(LAUNCHER_SCOPE) &&
    principal.user.kind === 'launcher'
      ? await findLauncherByUser(connection, principal.user.id)
      : undefined;
  if (!launcher || !token)
    throw new DomainError(403, 'launcherのtokenが必要です', 'launcher_token_required');
  return { launcherId: launcher.id, launcherName: launcher.name, tokenId: token.id };
}

export class LauncherService {
  constructor(private readonly database: Database) {}

  /** Everyone may pick a launcher for their site; tokens and revoked ones are administrators'. */
  async list(principal: Principal): Promise<Launcher[]> {
    requireScope(principal, 'read');
    const administrator = isGlobalAdministrator(principal);
    const launchers = await listLaunchers(this.database, { includeRevoked: administrator });
    return administrator ? launchers : launchers.map((launcher) => ({ ...launcher, tokenPrefix: null }));
  }

  async create(
    principal: Principal,
    request: { name: string; metadata: RequestMetadata },
  ): Promise<LauncherCreated> {
    requireGlobalAdmin(principal);
    return transaction(this.database, async (connection) => {
      const taken = await first(
        connection,
        'SELECT 1 FROM launchers WHERE lower(name)=lower($1) AND revoked_at IS NULL',
        [request.name],
      );
      if (taken) throw new DomainError(409, '同じ名前のlauncherがあります', 'launcher_name_taken');
      const launcherId = await insertLauncher(connection, {
        name: request.name,
        createdBy: principal.user.id,
      });
      const launcher = (await findLauncher(connection, launcherId))!;
      const token = await replaceLauncherToken(connection, {
        userId: launcher.userId,
        createdBy: principal.user.id,
      });
      await this.audit(connection, principal, {
        action: 'launcher.create',
        launcherId,
        metadata: request.metadata,
        details: { name: request.name },
      });
      return { launcher: await this.present(connection, launcherId), token };
    });
  }

  /** A new token for a launcher whose token was lost or leaked; the old one stops at once. */
  async replaceToken(
    principal: Principal,
    launcherId: string,
    metadata: RequestMetadata,
  ): Promise<LauncherCreated> {
    requireGlobalAdmin(principal);
    return transaction(this.database, async (connection) => {
      const launcher = await this.liveLauncher(connection, launcherId);
      const token = await replaceLauncherToken(connection, {
        userId: launcher.userId,
        createdBy: principal.user.id,
      });
      await this.audit(connection, principal, { action: 'launcher.token.replace', launcherId, metadata });
      return { launcher: await this.present(connection, launcherId), token };
    });
  }

  async revoke(principal: Principal, launcherId: string, metadata: RequestMetadata): Promise<void> {
    requireGlobalAdmin(principal);
    await transaction(this.database, async (connection) => {
      await this.liveLauncher(connection, launcherId);
      await revokeLauncher(connection, launcherId);
      await this.audit(connection, principal, { action: 'launcher.revoke', launcherId, metadata });
    });
  }

  /** What the launcher needs for its next poll: its sites, keys to make and checks to run. */
  async configuration(principal: Principal): Promise<LauncherConfiguration> {
    return transaction(this.database, async (connection) => {
      const launcher = await requireLauncher(connection, principal);
      await touchLauncher(connection, launcher.launcherId);
      const settings = await listLauncherSiteSettings(connection, launcher.launcherId);
      const targets = await rows<ComputeTarget>(
        connection,
        'SELECT * FROM compute_targets WHERE id=ANY($1::uuid[]) ORDER BY name,id',
        [[...settings.keys()]],
      );
      const sites = [];
      for (const target of targets)
        sites.push({
          target,
          settings: settings.get(target.id)!,
          jobShell: (await findCurrentJobShell(connection, target.id)) ?? null,
        });
      const checks = [];
      for (const check of await listLauncherConnectionChecks(connection, launcher.launcherId)) {
        const site = sites.find((candidate) => candidate.target.id === check.targetId);
        if (!site) continue;
        try {
          const account = await resolveSubmissionAccount(connection, {
            target: site.target,
            settings: site.settings,
            requesterId: check.userId ?? '',
            submittingUserId: null,
          });
          checks.push({ id: check.id, targetId: check.targetId, account });
        } catch (error) {
          if (!(error instanceof DomainError)) throw error;
          // The account changed since the check was asked for; report why instead of trying.
          await finishConnectionCheck(connection, {
            checkId: check.id,
            launcherId: launcher.launcherId,
            succeeded: false,
            message: error.message,
          });
        }
      }
      return {
        launcher: { id: launcher.launcherId, name: launcher.launcherName },
        sites,
        keys: await listLauncherKeys(connection, launcher.launcherId),
        checks,
      };
    });
  }

  /** The public half of a key the launcher made; the private half never leaves its host. */
  async publishKey(
    principal: Principal,
    keyId: string,
    request: { publicKey: string },
  ): Promise<SiteKey> {
    const parsed = parseSshPublicKey(request.publicKey);
    return transaction(this.database, async (connection) => {
      const launcher = await requireLauncher(connection, principal);
      const published = await publishSiteKey(connection, {
        keyId,
        launcherId: launcher.launcherId,
        ...parsed,
      });
      if (!published)
        throw new DomainError(409, 'この鍵は失効したか、別のlauncherの鍵です', 'site_key_revoked');
      if (published.previousFingerprint !== parsed.fingerprint)
        await writeAuditEvent(connection, {
          ...auditActor(principal),
          action: 'site.key.publish',
          outcome: 'success',
          resourceType: 'compute_target',
          resourceId: published.key.targetId,
          details: {
            keyId,
            userId: published.key.userId,
            fingerprint: parsed.fingerprint,
            previousFingerprint: published.previousFingerprint,
          },
        });
      return published.key;
    });
  }

  async reportConnectionCheck(
    principal: Principal,
    checkId: string,
    result: { outcome: 'succeeded' | 'failed'; message?: string | null },
  ): Promise<void> {
    await transaction(this.database, async (connection) => {
      const launcher = await requireLauncher(connection, principal);
      const finished = await finishConnectionCheck(connection, {
        checkId,
        launcherId: launcher.launcherId,
        succeeded: result.outcome === 'succeeded',
        message: result.message?.trim() || null,
      });
      if (!finished) notFound('SiteConnectionCheck');
    });
  }

  private async liveLauncher(connection: Connection, launcherId: string) {
    const launcher = await findLauncher(connection, launcherId);
    if (!launcher || launcher.revokedAt) notFound('Launcher');
    return launcher;
  }

  private async present(connection: Connection, launcherId: string): Promise<Launcher> {
    const { userId: _userId, ...launcher } = (await findLauncher(connection, launcherId))!;
    return launcher;
  }

  private async audit(
    connection: Connection,
    principal: Principal,
    event: {
      action: string;
      launcherId: string;
      metadata: RequestMetadata;
      details?: JsonObject;
    },
  ): Promise<void> {
    await writeAuditEvent(connection, {
      ...auditActor(principal),
      ...event.metadata,
      action: event.action,
      outcome: 'success',
      resourceType: 'launcher',
      resourceId: event.launcherId,
      details: event.details ?? {},
    });
  }
}
