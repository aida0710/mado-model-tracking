import type { ProjectMember, ProjectRole } from '@mmt/contracts';

/** Where a member's Project role comes from: a direct grant or an Authentik group binding. */
export type ProjectMemberSource =
  | { kind: 'direct'; role: ProjectRole }
  | { kind: 'group'; group: string; role: ProjectRole };

/** Direct grant first, then group bindings by name, so the same member always reads the same. */
export function listProjectMemberSources(member: ProjectMember): ProjectMemberSource[] {
  const groupSources = [...member.groups]
    .sort((left, right) => left.group.localeCompare(right.group))
    .map(({ group, role }): ProjectMemberSource => ({ kind: 'group', group, role }));
  return member.directRole === null
    ? groupSources
    : [{ kind: 'direct', role: member.directRole }, ...groupSources];
}

/**
 * Only a direct grant can be edited or removed on this screen. A member who holds the role
 * through groups alone keeps it until the group binding or the Authentik membership changes.
 */
export function hasDirectGrant(member: ProjectMember): boolean {
  return member.directRole !== null;
}
