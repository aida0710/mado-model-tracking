import type { SitePersonalSettings, SitePersonalSettingsInput } from '@mmt/contracts';
import type { Principal } from '../auth/principal.js';
import { transaction, type Database } from '../db/database.js';
import { DomainError } from '../domain/errors.js';
import type { RequestMetadata } from '../http/requestMetadata.js';
import { writeAuditEvent } from '../repositories/auditRepository.js';
import { reconcileSiteKeys } from '../repositories/siteKeyRepository.js';
import {
  deletePersonalSettings,
  findPersonalSettings,
  listPersonalSettings,
  savePersonalSettings,
} from '../repositories/sitePersonalSettingsRepository.js';
import { findSiteSettings, lockSiteSettings } from '../repositories/siteSettingsRepository.js';
import { requireScope } from './accessService.js';
import { auditActor } from './auditService.js';
import { findSiteTarget, requireTargetManager, requireTargetUser } from './siteAccess.js';
import { requireSession } from './tokenService.js';

/**
 * What each person sets for a site: their account, work directory and variables. On a site the
 * launcher logs in to with each requester's own account, saving an account name asks the
 * launcher for that person's key.
 */
export class SitePersonalSettingsService {
  constructor(private readonly database: Database) {}

  async listAll(principal: Principal, targetId: string): Promise<SitePersonalSettings[]> {
    requireScope(principal, 'read');
    const target = await findSiteTarget(this.database, targetId);
    requireTargetManager(principal, target);
    return listPersonalSettings(this.database, targetId);
  }

  async getOwn(principal: Principal, targetId: string): Promise<SitePersonalSettings | null> {
    requireScope(principal, 'read');
    const target = await findSiteTarget(this.database, targetId);
    await requireTargetUser(this.database, principal, target);
    return (await findPersonalSettings(this.database, { targetId, userId: principal.user.id })) ?? null;
  }

  async saveOwn(
    principal: Principal,
    targetId: string,
    request: { input: SitePersonalSettingsInput; metadata: RequestMetadata },
  ): Promise<SitePersonalSettings> {
    requireSession(principal, 'コンピュータの自分の設定');
    return transaction(this.database, async (connection) => {
      const target = await findSiteTarget(connection, targetId, { lock: true });
      await requireTargetUser(connection, principal, target);
      await lockSiteSettings(connection, targetId);
      const site = (await findSiteSettings(connection, targetId))!;
      // A shared account's work directory and variables are its manager's alone.
      if (target.submissionMode === 'automatic' && site.accountMode === 'shared')
        throw new DomainError(
          422,
          'このコンピュータは共用アカウントで動くので、自分の設定は使いません',
          'site_settings_invalid',
        );
      const owner = { targetId, userId: principal.user.id };
      const previous = await findPersonalSettings(connection, owner);
      const settings = {
        ...owner,
        accountName: request.input.accountName ?? previous?.accountName ?? '',
        workDirectory:
          request.input.workDirectory !== undefined
            ? request.input.workDirectory || null
            : (previous?.workDirectory ?? null),
        variables: request.input.variables ?? previous?.variables ?? {},
      };
      if (target.submissionMode === 'automatic' && site.accountMode === 'personal' && !settings.accountName)
        throw new DomainError(
          422,
          'このコンピュータは本人のアカウントで動くので、アカウント名が必要です',
          'site_settings_invalid',
        );
      await savePersonalSettings(connection, settings);
      await reconcileSiteKeys(connection, {
        targetId,
        automatic: target.submissionMode === 'automatic',
        settings: site,
      });
      await writeAuditEvent(connection, {
        ...auditActor(principal),
        ...request.metadata,
        action: 'site.personal_settings.update',
        outcome: 'success',
        resourceType: 'compute_target',
        resourceId: targetId,
        details: {
          accountName: settings.accountName,
          previousAccountName: previous?.accountName ?? null,
          variableNames: Object.keys(settings.variables),
        },
      });
      return (await findPersonalSettings(connection, owner))!;
    });
  }

  /** Deleting one's settings also revokes one's key for the site. */
  async deleteOwn(principal: Principal, targetId: string, metadata: RequestMetadata): Promise<void> {
    requireSession(principal, 'コンピュータの自分の設定');
    await transaction(this.database, async (connection) => {
      const target = await findSiteTarget(connection, targetId, { lock: true });
      await requireTargetUser(connection, principal, target);
      await lockSiteSettings(connection, targetId);
      if (!(await deletePersonalSettings(connection, { targetId, userId: principal.user.id }))) return;
      const site = (await findSiteSettings(connection, targetId))!;
      await reconcileSiteKeys(connection, {
        targetId,
        automatic: target.submissionMode === 'automatic',
        settings: site,
      });
      await writeAuditEvent(connection, {
        ...auditActor(principal),
        ...metadata,
        action: 'site.personal_settings.delete',
        outcome: 'success',
        resourceType: 'compute_target',
        resourceId: targetId,
      });
    });
  }
}
