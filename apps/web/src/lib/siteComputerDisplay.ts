import type {
  ComputeTargetDetails,
  Launcher,
  Project,
  SiteConnectionCheck,
  SiteKey,
} from '@mmt/contracts';
import type { SelectOption } from '../types/form';
import { canEditProject } from './permissions';
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
 * The Projects an owned computer may be shared with: those where one is an editor or above (the
 * API refuses others with target_project_forbidden), and those it is already shared with, so they
 * can still be taken off.
 */
export function shareableProjectOptions(
  projects: ReadonlyArray<Pick<Project, 'id' | 'name' | 'role'>>,
  sharedProjectIds: readonly string[],
): SelectOption[] {
  const editable = projects
    .filter((project) => canEditProject(project.role))
    .map((project) => project.id);
  return [...new Set([...editable, ...sharedProjectIds])].map((id) => ({
    value: id,
    label: projectName(projects, id),
  }));
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

/** The newest check (the API lists them newest first) still waits for the launcher. */
export const isConnectionCheckInProgress = (checks: readonly SiteConnectionCheck[]): boolean =>
  checks[0]?.status === 'queued';

export const shortSha256 = (sha256: string): string => sha256.slice(0, SHORT_SHA256_LENGTH);
