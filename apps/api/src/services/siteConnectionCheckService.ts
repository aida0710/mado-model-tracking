import type { SiteConnectionCheck } from '@mmt/contracts';
import type { Principal } from '../auth/principal.js';
import { transaction, type Database } from '../db/database.js';
import { DomainError } from '../domain/errors.js';
import {
  expireStaleConnectionChecks,
  insertConnectionCheck,
  listConnectionChecks,
} from '../repositories/siteConnectionCheckRepository.js';
import { findLiveSiteKey } from '../repositories/siteKeyRepository.js';
import { requireScope } from './accessService.js';
import { findSiteTarget } from './siteAccess.js';
import { siteKeyAccount } from './siteKeyService.js';

/**
 * The launcher logs in once with an account's key and runs `true`, so the owner of the account
 * knows the public key was authorized before any Job is submitted.
 */
export class SiteConnectionCheckService {
  constructor(private readonly database: Database) {}

  async request(
    principal: Principal,
    targetId: string,
    request: { personal: boolean },
  ): Promise<SiteConnectionCheck> {
    return transaction(this.database, async (connection) => {
      const target = await findSiteTarget(connection, targetId);
      const account = await siteKeyAccount(connection, principal, { target, personal: request.personal });
      const key = await findLiveSiteKey(connection, { targetId, userId: account.userId });
      if (key?.status !== 'ready')
        throw new DomainError(
          422,
          'launcherがまだ鍵を作っていません。launcherが動いているか確かめてください',
          'site_check_unavailable',
        );
      await expireStaleConnectionChecks(connection);
      const check = await insertConnectionCheck(connection, {
        targetId,
        userId: account.userId,
        requestedBy: principal.user.id,
      });
      if (!check)
        throw new DomainError(409, 'このアカウントの接続確認は実行中です', 'site_check_in_progress');
      return check;
    });
  }

  async list(
    principal: Principal,
    targetId: string,
    query: { personal: boolean },
  ): Promise<SiteConnectionCheck[]> {
    requireScope(principal, 'read');
    return transaction(this.database, async (connection) => {
      const target = await findSiteTarget(connection, targetId);
      const account = await siteKeyAccount(connection, principal, { target, personal: query.personal });
      await expireStaleConnectionChecks(connection);
      return listConnectionChecks(connection, { targetId, userId: account.userId });
    });
  }
}
