import type { ProjectMemberGrant, ProjectRole, UserSearchResult } from '@mmt/contracts';

// A member added while creating a Project can record Runs; the creator changes it per row.
export const DEFAULT_MEMBER_GRANT_ROLE: ProjectRole = 'editor';

/** A member chosen in the creation dialog, with the name shown in its row. */
export interface MemberGrantDraft {
  user: UserSearchResult;
  role: ProjectRole;
}

/** Adds `user` with the default role; a user already in the list keeps their row. */
export function addMemberGrant(
  drafts: MemberGrantDraft[],
  user: UserSearchResult,
): MemberGrantDraft[] {
  if (drafts.some((draft) => draft.user.id === user.id)) return drafts;
  return [...drafts, { user, role: DEFAULT_MEMBER_GRANT_ROLE }];
}

export function changeMemberGrantRole(
  drafts: MemberGrantDraft[],
  { userId, role }: { userId: string; role: ProjectRole },
): MemberGrantDraft[] {
  return drafts.map((draft) => (draft.user.id === userId ? { ...draft, role } : draft));
}

export function removeMemberGrant(drafts: MemberGrantDraft[], userId: string): MemberGrantDraft[] {
  return drafts.filter((draft) => draft.user.id !== userId);
}

/** The grants POST /projects takes. */
export function toProjectMemberGrants(drafts: MemberGrantDraft[]): ProjectMemberGrant[] {
  return drafts.map(({ user, role }) => ({ userId: user.id, role }));
}
