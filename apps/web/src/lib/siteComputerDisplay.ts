import type {
  ComputeTargetDetails,
  Launcher,
  Project,
  ShareableProject,
  SiteConnectionCheck,
  SiteKey,
} from '@mmt/contracts';
import type { SelectOption } from '../types/form';
import { text } from '../i18n/catalog';
import { siteComputersTextTemplates } from '../i18n/siteComputers';

// Enough of a SHA-256 to tell versions apart in a table; the full value is in the title.
const SHORT_SHA256_LENGTH = 12;

/** Whose computer it is, for the Compute list: a global one, one's own, or someone else's. */
export function targetOwnerLabel(
  target: Pick<ComputeTargetDetails, 'ownerUserId' | 'ownerName'>,
  userId: string,
): string {
  if (target.ownerUserId === null) return text.targetOwnerGlobal;
  if (target.ownerUserId === userId) return text.targetOwnerSelf;
  return siteComputersTextTemplates.targetOwnerName(target.ownerName ?? target.ownerUserId);
}

/**
 * Where a computer may be used: every Project for a global one, otherwise the Projects its owner
 * shared it with. Only its owner and global administrators see those; for others it is null.
 */
export function targetSharingLabel(
  target: Pick<ComputeTargetDetails, 'ownerUserId' | 'projectIds'>,
  projects: ReadonlyArray<Pick<Project, 'id' | 'name'>>,
  canSeeSharing: boolean,
): string | null {
  if (target.ownerUserId === null) return text.targetSharedEverywhere;
  if (!canSeeSharing) return null;
  if (!target.projectIds.length) return text.targetSharedNowhere;
  return target.projectIds.map((id) => projectName(projects, id)).join(', ');
}

const projectName = (projects: ReadonlyArray<Pick<Project, 'id' | 'name'>>, id: string) =>
  projects.find((project) => project.id === id)?.name ?? id;

/**
 * The Projects an owned computer may be shared with: those its owner may share it with, as the API
 * lists them, then those an edited one is already shared with that its owner no longer may
 * (marked, and named from the editor's Projects), so they can be taken off. Keeping one of those
 * while changing the others is refused.
 */
export function targetSharingOptions(
  ownerProjects: readonly ShareableProject[],
  sharedProjectIds: readonly string[],
  projects: ReadonlyArray<Pick<Project, 'id' | 'name'>>,
): SelectOption[] {
  const shareableIds = new Set(ownerProjects.map((project) => project.id));
  return [
    ...ownerProjects.map((project) => ({ value: project.id, label: project.name })),
    ...sharedProjectIds
      .filter((id) => !shareableIds.has(id))
      .map((id) => ({
        value: id,
        label: siteComputersTextTemplates.projectNoLongerShareable(projectName(projects, id)),
      })),
  ];
}

/**
 * The launchers a site may be given: the live ones, and the one it has even when that was revoked
 * (global administrators see it by name, others by its id), so the form shows it until changed.
 */
export function launcherOptions(
  launchers: readonly Launcher[],
  selectedId: string,
): SelectOption[] {
  const revoked = (name: string) => `${name}（${text.launcherRevoked}）`;
  const options = launchers
    .filter((launcher) => launcher.revokedAt === null || launcher.id === selectedId)
    .map((launcher) => ({
      value: launcher.id,
      label: launcher.revokedAt === null ? launcher.name : revoked(launcher.name),
    }));
  const isListed = options.some((option) => option.value === selectedId);
  if (!selectedId || isListed) return options;
  return [...options, { value: selectedId, label: revoked(selectedId) }];
}

/** The shared account's key among a site's live keys; personal keys belong to one person each. */
export function sharedAccountKey(keys: readonly SiteKey[]): SiteKey | null {
  return keys.find((key) => key.userId === null) ?? null;
}

/** The launcher has not published the key's public half yet. */
export const isKeyRequested = (key: SiteKey | null | undefined): boolean =>
  key?.status === 'requested';

/**
 * The launcher has made the key, so it can log in with it; the API refuses a login check before
 * that (site_check_unavailable).
 */
export const isKeyReady = (key: SiteKey | null | undefined): boolean => key?.status === 'ready';

/** The newest check (the API lists them newest first) still waits for the launcher. */
export const isConnectionCheckInProgress = (checks: readonly SiteConnectionCheck[]): boolean =>
  checks[0]?.status === 'queued';

export const shortSha256 = (sha256: string): string => sha256.slice(0, SHORT_SHA256_LENGTH);
