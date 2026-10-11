import type { ComputeTarget, Launcher, SiteConnectionCheck, SiteKey } from '@mmt/contracts';
import type { SelectOption } from '../types/form';
import { text } from '../i18n/catalog';

// Enough of a SHA-256 to tell versions apart in a table; the full value is in the title.
const SHORT_SHA256_LENGTH = 12;

/**
 * Whose a computer is, for the lists: everyone's (one from before owners), one's own, or its
 * owner's name (their ID when the name is unknown).
 */
export function targetOwnerLabel(
  target: Pick<ComputeTarget, 'ownerUserId'> & { ownerName: string | null },
  userId: string,
): string {
  if (target.ownerUserId === null) return text.targetOwnerGlobal;
  if (target.ownerUserId === userId) return text.targetOwnerSelf;
  return target.ownerName ?? target.ownerUserId;
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
