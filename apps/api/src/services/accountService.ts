import type { Account } from '@mmt/contracts';
import type { Principal } from '../auth/principal.js';
import type { Database } from '../db/database.js';
import { listUserGroups } from '../repositories/identityRepository.js';
import {
  findAdminUser,
  findGroupsSyncedAt,
} from '../repositories/userAdministrationRepository.js';
import { requireScope } from './accessService.js';

/** The signed-in user's own profile for the /account screen. */
export class AccountService {
  constructor(private readonly database: Database) {}

  async get(principal: Principal): Promise<Account> {
    requireScope(principal, 'read');
    const userId = principal.user.id;
    const [user, groups, groupsSyncedAt] = await Promise.all([
      findAdminUser(this.database, userId),
      listUserGroups(this.database, userId),
      findGroupsSyncedAt(this.database, userId),
    ]);
    return {
      user: user!,
      groups,
      groupsSyncedAt,
      sessionAuthMethod: principal.session?.authMethod ?? null,
    };
  }
}
