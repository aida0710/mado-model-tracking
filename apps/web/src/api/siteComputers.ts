import type {
  ComputeTargetDetails,
  ComputeTargetSharing,
  SiteConnectionCheck,
  SiteConnectionCheckRequest,
  SiteJobShell,
  SiteJobShellCreate,
  SiteJobShellSummary,
  SiteKey,
  SiteKeyRotate,
  SitePersonalSettings,
  SitePersonalSettingsInput,
  SitePersonalSettingsLookup,
} from '@mmt/contracts';
import { encodeId, invalidResponseError, jsonRequest, request, requestItems } from './http';

// Computers added on the Web: who they are shared with, their job shell versions, the personal
// settings of the people who use them, and the launcher's keys and connection checks.

const targetPath = (targetId: string) => `/targets/${encodeId(targetId)}`;
const jobShellsPath = (targetId: string) => `${targetPath(targetId)}/job-shells`;
const myPersonalSettingsPath = (targetId: string) =>
  `${targetPath(targetId)}/personal-settings/me`;

/** One's own settings for the site; null until one saves them. */
async function myPersonalSettings(
  targetId: string,
  signal?: AbortSignal,
): Promise<SitePersonalSettings | null> {
  const lookup = await request<SitePersonalSettingsLookup>(myPersonalSettingsPath(targetId), {
    signal,
  });
  // `item: null` means "not saved yet"; a missing item would read the same, so it is refused.
  if (lookup.item === undefined) throw invalidResponseError();
  return lookup.item;
}

export const siteComputersApi = {
  /** Owned computers only: the Projects whose members may use it besides its owner. */
  setProjects: (targetId: string, body: ComputeTargetSharing) =>
    request<ComputeTargetDetails>(`${targetPath(targetId)}/projects`, jsonRequest('PUT', body)),
  /** The job shell's versions, newest (the current one) first. */
  jobShells: (targetId: string, signal?: AbortSignal) =>
    requestItems<SiteJobShellSummary>(jobShellsPath(targetId), signal),
  jobShell: (targetId: string, jobShellId: string, signal?: AbortSignal) =>
    request<SiteJobShell>(`${jobShellsPath(targetId)}/${encodeId(jobShellId)}`, { signal }),
  /** Saves the next version for later submissions; the current content returns the current one. */
  createJobShell: (targetId: string, body: SiteJobShellCreate) =>
    request<SiteJobShell>(jobShellsPath(targetId), jsonRequest('POST', body)),
  /** Everyone's settings for the site; its owner and global administrators only. */
  personalSettings: (targetId: string, signal?: AbortSignal) =>
    requestItems<SitePersonalSettings>(`${targetPath(targetId)}/personal-settings`, signal),
  myPersonalSettings,
  /** On a site that logs in as each person, saving the account asks the launcher for a key. */
  saveMyPersonalSettings: (targetId: string, body: SitePersonalSettingsInput) =>
    request<SitePersonalSettings>(myPersonalSettingsPath(targetId), jsonRequest('PUT', body)),
  /** Removes one's settings and revokes one's key. */
  deleteMyPersonalSettings: (targetId: string) =>
    request<void>(myPersonalSettingsPath(targetId), { method: 'DELETE' }),
  /** Live keys: all of them for the owner and global administrators, one's own for others. */
  keys: (targetId: string, signal?: AbortSignal) =>
    requestItems<SiteKey>(`${targetPath(targetId)}/keys`, signal),
  /** Revokes the shared (personal=false) or one's own key and asks the launcher for a new one. */
  rotateKey: (targetId: string, body: SiteKeyRotate) =>
    request<SiteKey>(`${targetPath(targetId)}/keys/rotate`, jsonRequest('POST', body)),
  requestConnectionCheck: (targetId: string, body: SiteConnectionCheckRequest) =>
    request<SiteConnectionCheck>(
      `${targetPath(targetId)}/connection-checks`,
      jsonRequest('POST', body),
    ),
  /** The newest checks of the shared account (personal=false) or of one's own account. */
  connectionChecks: (targetId: string, personal: boolean, signal?: AbortSignal) =>
    requestItems<SiteConnectionCheck>(
      `${targetPath(targetId)}/connection-checks?${new URLSearchParams({ personal: String(personal) })}`,
      signal,
    ),
};
