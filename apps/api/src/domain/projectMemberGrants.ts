import type { ProjectMemberGrant, User } from '@mmt/contracts';
import { DomainError, notFound } from './errors.js';

export type GrantableUserState = Pick<User, 'id' | 'kind' | 'status'>;

/**
 * The members to add when a Project is created. A user listed twice refuses the request; the
 * creator is left out because the creator is always the Project admin.
 */
export function initialMemberGrants(
  grants: readonly ProjectMemberGrant[],
  creatorId: string,
): ProjectMemberGrant[] {
  const listed = new Set<string>();
  for (const { userId } of grants) {
    const key = userId.toLowerCase();
    if (listed.has(key))
      throw new DomainError(400, '同じユーザーが2回指定されています', 'duplicate_project_member');
    listed.add(key);
  }
  return grants.filter((grant) => grant.userId.toLowerCase() !== creatorId.toLowerCase());
}

/**
 * Refuses the whole request unless every grant names an active person: Service Accounts get their
 * role on the account itself, and launchers are never members.
 */
export function assertGrantableUsers(
  grants: readonly ProjectMemberGrant[],
  users: readonly GrantableUserState[],
): void {
  const usersById = new Map(users.map((user) => [user.id.toLowerCase(), user]));
  for (const { userId } of grants) {
    const user = usersById.get(userId.toLowerCase());
    if (!user) notFound('User');
    if (user.kind !== 'human' || user.status !== 'active')
      throw new DomainError(
        400,
        'メンバーに追加できるのは有効な利用者だけです',
        'invalid_project_member',
      );
  }
}
