import type { UserSearchResult } from '@mmt/contracts';
import type { Principal } from '../auth/principal.js';
import type { Database } from '../db/database.js';
import { DomainError } from '../domain/errors.js';
import {
  holdsAnyProjectAdminRole,
  listKnownGroupNames,
  searchActiveUsers,
} from '../repositories/identityRepository.js';
import { requireScope } from './accessService.js';

// Enough candidates to pick from while typing, without letting admins page through every user.
const USER_SEARCH_LIMIT = 20;

// Lookups behind the Project access settings: users to grant a role and known SSO groups.
export class UserDirectoryService {
  constructor(private readonly database: Database) {}

  // Whoever may create a Project (POST /projects) picks its first members here, so the same check
  // applies. A Project-scoped token cannot create Projects and still needs the admin role there.
  async searchUsers(principal: Principal, query: string): Promise<UserSearchResult[]> {
    requireScope(principal, 'admin');
    if (principal.token?.projectId) await this.requireAccessAdministrator(principal);
    return searchActiveUsers(this.database, { query, limit: USER_SEARCH_LIMIT });
  }

  async listGroups(principal: Principal): Promise<string[]> {
    await this.requireAccessAdministrator(principal);
    return listKnownGroupNames(this.database);
  }

  // Global administrators (as in requireGlobalAdmin) and admins of any Project. A
  // Project-scoped token only counts the admin role of its own Project.
  private async requireAccessAdministrator(principal: Principal): Promise<void> {
    requireScope(principal, 'admin');
    if (principal.user.isAdmin && !principal.token?.projectId) return;
    const isProjectAdmin = await holdsAnyProjectAdminRole(this.database, {
      userId: principal.user.id,
      projectId: principal.token?.projectId ?? null,
    });
    if (!isProjectAdmin)
      throw new DomainError(403, 'Project管理者の権限が必要です', 'project_forbidden');
  }
}
