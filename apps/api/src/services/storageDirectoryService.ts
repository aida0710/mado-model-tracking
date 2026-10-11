import type { Dirent } from 'node:fs';
import { opendir, stat } from 'node:fs/promises';
import path from 'node:path';
import type { DirectorySuggestions } from '@mmt/contracts';
import type { Principal } from '../auth/principal.js';
import {
  compareDirectoryNames,
  isSuggestedName,
  planDirectorySuggestions,
  type DirectorySuggestionPlan,
} from '../domain/directorySuggestionRules.js';
import { requireGlobalAdmin } from './accessService.js';

// Enough to scan while typing; a longer list means the administrator should type more of the name.
export const DIRECTORY_SUGGESTION_LIMIT = 50;
// Entries read from the listed directory per request, so each keystroke in a huge directory stays
// cheap. Matches past this are not seen, and the answer is marked truncated.
export const DIRECTORY_SCAN_LIMIT = 5000;
// A mount that stopped answering (NFS) must not hold the request; past this nothing is suggested.
export const DIRECTORY_SUGGESTION_TIMEOUT_MS = 2000;

interface DirectoryScan {
  names: string[];
  isCut: boolean;
}

async function pathStatus(resolvedPath: string): Promise<DirectorySuggestions['status']> {
  try {
    return (await stat(resolvedPath)).isDirectory() ? 'directory' : 'not_directory';
  } catch {
    // Missing, or not visible to the API process; either way nothing is there to use yet.
    return 'missing';
  }
}

async function isDirectoryEntry(entry: Dirent, plan: DirectorySuggestionPlan): Promise<boolean> {
  if (entry.isDirectory()) return true;
  if (!entry.isSymbolicLink()) return false;
  // A symlink counts when it leads to a directory; a broken one is skipped.
  const target = await stat(path.join(plan.listedDirectory, entry.name)).catch(() => undefined);
  return target?.isDirectory() ?? false;
}

/** Entries of the listed directory whose names fit the typed prefix, reading at most scanLimit. */
async function readMatchingEntries(
  plan: DirectorySuggestionPlan,
  scanLimit: number,
): Promise<{ entries: Dirent[]; isCut: boolean }> {
  const entries: Dirent[] = [];
  let scanned = 0;
  try {
    // Leaving the loop early closes the directory handle.
    for await (const entry of await opendir(plan.listedDirectory)) {
      if (scanned === scanLimit) return { entries, isCut: true };
      scanned += 1;
      if (isSuggestedName(entry.name, plan)) entries.push(entry);
    }
  } catch {
    // An unreadable or missing directory has nothing to suggest; the caller sees an empty list.
    return { entries: [], isCut: false };
  }
  return { entries, isCut: false };
}

/** Names of matching directories in name order, at most `limit` of them. */
async function matchingDirectoryNames(
  plan: DirectorySuggestionPlan,
  limits: { names: number; scan: number },
): Promise<DirectoryScan> {
  const { entries, isCut } = await readMatchingEntries(plan, limits.scan);
  entries.sort((left, right) => compareDirectoryNames(left.name, right.name));
  const names: string[] = [];
  for (const entry of entries) {
    if (names.length >= limits.names) break;
    if (await isDirectoryEntry(entry, plan)) names.push(entry.name);
  }
  return { names, isCut };
}

/** Resolves to undefined after `milliseconds`; `cancel` stops the timer when the work ends first. */
function deadline(milliseconds: number): { expired: Promise<undefined>; cancel: () => void } {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), milliseconds);
  });
  return { expired, cancel: () => clearTimeout(timer) };
}

/**
 * Directories on the API server that complete a filesystem backend's rootPath as an administrator
 * types it (GET /admin/storage-directories). File system failures are answered with no items.
 */
export class StorageDirectoryService {
  constructor(
    private readonly limits: { scan: number; timeoutMs: number } = {
      scan: DIRECTORY_SCAN_LIMIT,
      timeoutMs: DIRECTORY_SUGGESTION_TIMEOUT_MS,
    },
    // Replaced in tests to stand for a directory read that never answers.
    private readonly scanDirectory: typeof matchingDirectoryNames = matchingDirectoryNames,
  ) {}

  async suggest(principal: Principal, typedPath: string): Promise<DirectorySuggestions> {
    requireGlobalAdmin(principal);
    // The working directory at call time is what the filesystem backend resolves rootPath from.
    const plan = planDirectorySuggestions(typedPath, process.cwd());
    const timer = deadline(this.limits.timeoutMs);
    // One more name than the limit tells whether the list was cut.
    const found = await Promise.race([
      Promise.all([
        pathStatus(plan.resolvedPath),
        this.scanDirectory(plan, { names: DIRECTORY_SUGGESTION_LIMIT + 1, scan: this.limits.scan }),
      ]),
      timer.expired,
    ]).finally(timer.cancel);
    if (!found)
      return { resolvedPath: plan.resolvedPath, status: 'unavailable', items: [], truncated: true };
    const [status, scan] = found;
    return {
      resolvedPath: plan.resolvedPath,
      status,
      items: scan.names
        .slice(0, DIRECTORY_SUGGESTION_LIMIT)
        .map((name) => path.join(plan.listedDirectory, name)),
      truncated: scan.isCut || scan.names.length > DIRECTORY_SUGGESTION_LIMIT,
    };
  }
}
