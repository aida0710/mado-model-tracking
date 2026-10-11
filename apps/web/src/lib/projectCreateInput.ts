import type { ArtifactBackend, ProjectCreate, ProjectVisibility } from '@mmt/contracts';
import { toProjectMemberGrants, type MemberGrantDraft } from './projectMemberGrants';

// The API's default as well: a new Project is open to everyone who can sign in.
export const DEFAULT_PROJECT_VISIBILITY: ProjectVisibility = 'public';

/**
 * The POST /projects body from the creation dialog. Members are sent only for a Private Project,
 * where the field shows; a blank description is left out.
 */
export function buildProjectCreate({
  name,
  description,
  visibility,
  artifactBackend,
  memberDrafts,
}: {
  name: string;
  description: string;
  visibility: ProjectVisibility;
  artifactBackend: ArtifactBackend;
  memberDrafts: MemberGrantDraft[];
}): ProjectCreate {
  const trimmedDescription = description.trim();
  return {
    name: name.trim(),
    ...(trimmedDescription ? { description: trimmedDescription } : {}),
    artifactBackend,
    visibility,
    ...(visibility === 'private' && memberDrafts.length > 0
      ? { members: toProjectMemberGrants(memberDrafts) }
      : {}),
  };
}
