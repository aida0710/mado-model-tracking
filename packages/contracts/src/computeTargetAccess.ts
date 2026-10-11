import type { ComputeTargetExecutor } from './index.js';
import type { CpuArch, SiteSubmissionMode } from './siteExecution.js';

/**
 * Whose Jobs may run on a computer (docs/sites.md). A public computer takes the Jobs of every
 * Project; a private one only those of its owner and of the Service Accounts its owner created.
 * A private computer always has an owner. Global administrators manage every computer but run
 * Jobs on someone else's private one no more than anyone else does.
 */
export type ComputeTargetVisibility = 'public' | 'private';
export const COMPUTE_TARGET_VISIBILITIES: readonly ComputeTargetVisibility[] = ['public', 'private'];

/** The launcher that submits an automatic site's Jobs, as anyone may see it. */
export interface ComputeTargetLauncherStatus {
  name: string;
  /** The launcher's last configuration read or claim; null before the first. */
  lastSeenAt: string | null;
  revoked: boolean;
}

/**
 * GET /targets/overview: every computer, someone else's private one too, with only what anyone may
 * know about it. How it is reached (host, accounts, paths, a site's settings) is in GET /targets,
 * for those who may use or manage it.
 */
export interface ComputeTargetOverview {
  id: string;
  name: string;
  executor: ComputeTargetExecutor;
  /** Sites: whether a launcher or the requester (`mado-tracking submit`) submits. */
  submissionMode: SiteSubmissionMode;
  cpuArch: CpuArch;
  /** Sites: the job shell submits an array in one call. */
  supportsArray: boolean;
  enabled: boolean;
  visibility: ComputeTargetVisibility;
  /** null: a computer from before owners, managed by global administrators. */
  ownerUserId: string | null;
  ownerName: string | null;
  /** The caller's Jobs may run here. */
  usable: boolean;
  /** The caller may change it, its job shell and its keys: its owner or a global administrator. */
  canManage: boolean;
  /** Automatic sites that name a launcher; null for other computers. */
  launcher: ComputeTargetLauncherStatus | null;
}
