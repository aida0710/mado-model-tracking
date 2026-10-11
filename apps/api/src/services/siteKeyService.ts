import type { ComputeTarget, SiteKey } from '@mmt/contracts';
import type { Principal } from '../auth/principal.js';
import { transaction, type Connection, type Database } from '../db/database.js';
import { DomainError } from '../domain/errors.js';
import type { RequestMetadata } from '../http/requestMetadata.js';
import { writeAuditEvent } from '../repositories/auditRepository.js';
import {
  findLiveSiteKey,
  listLiveSiteKeys,
  requestSiteKey,
  revokeSiteKey,
} from '../repositories/siteKeyRepository.js';
import { findPersonalSettings } from '../repositories/sitePersonalSettingsRepository.js';
import { findSiteSettings, lockSiteSettings } from '../repositories/siteSettingsRepository.js';
import { requireScope } from './accessService.js';
import { auditActor } from './auditService.js';
import {
  findSiteTarget,
  isTargetManager,
  requireTargetManager,
  requireTargetUser,
} from './siteAccess.js';

function keyUnavailable(message: string): never {
  throw new DomainError(422, message, 'site_key_unavailable');
}

/**
 * The account a key or connection check is for: the shared account (personal=false, the site's
 * manager) or the caller's own account on a site that logs in as each requester.
 */
export async function siteKeyAccount(
  connection: Connection,
  principal: Principal,
  request: { target: ComputeTarget; personal: boolean },
): Promise<{ userId: string | null; launcherId: string }> {
  const { target } = request;
  const settings = await findSiteSettings(connection, target.id);
  if (target.submissionMode !== 'automatic' || !settings?.launcherId)
    keyUnavailable('launcherが投入するコンピュータにだけ鍵があります');
  if (!request.personal) {
    requireTargetManager(principal, target);
    if (settings.accountMode !== 'shared') keyUnavailable('このコンピュータは共用アカウントを使いません');
    return { userId: null, launcherId: settings.launcherId };
  }
  await requireTargetUser(connection, principal, target);
  if (settings.accountMode !== 'personal') keyUnavailable('このコンピュータは共用アカウントで動きます');
  const personal = await findPersonalSettings(connection, {
    targetId: target.id,
    userId: principal.user.id,
  });
  if (!personal?.accountName) keyUnavailable('先に「自分の設定」でアカウント名を登録してください');
  return { userId: principal.user.id, launcherId: settings.launcherId };
}

/** Keys the launcher made for a site; only their public halves exist in tracking. */
export class SiteKeyService {
  constructor(private readonly database: Database) {}

  /** The site's manager sees every live key; anyone else only their own. */
  async list(principal: Principal, targetId: string): Promise<SiteKey[]> {
    requireScope(principal, 'read');
    const target = await findSiteTarget(this.database, targetId);
    await requireTargetUser(this.database, principal, target);
    const keys = await listLiveSiteKeys(this.database, targetId);
    if (isTargetManager(principal, target)) return keys;
    return keys.filter((key) => key.userId === principal.user.id);
  }

  /** Revokes the account's key and asks the launcher for a new one, to be authorized again. */
  async rotate(
    principal: Principal,
    targetId: string,
    request: { personal: boolean; metadata: RequestMetadata },
  ): Promise<SiteKey> {
    return transaction(this.database, async (connection) => {
      const target = await findSiteTarget(connection, targetId, { lock: true });
      await lockSiteSettings(connection, targetId);
      const account = await siteKeyAccount(connection, principal, { target, personal: request.personal });
      const previous = await findLiveSiteKey(connection, { targetId, userId: account.userId });
      if (previous) await revokeSiteKey(connection, previous.id);
      const key = await requestSiteKey(connection, { targetId, ...account });
      await writeAuditEvent(connection, {
        ...auditActor(principal),
        ...request.metadata,
        action: 'site.key.rotate',
        outcome: 'success',
        resourceType: 'compute_target',
        resourceId: targetId,
        details: {
          keyId: key.id,
          userId: account.userId,
          previousFingerprint: previous?.fingerprint ?? null,
        },
      });
      return key;
    });
  }
}
