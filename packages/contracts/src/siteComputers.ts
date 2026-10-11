import type { ComputeTarget } from './index.js';

/**
 * Computers added on the Web (docs/sites.md). A site's settings live in tracking: the global
 * settings (connection, job shell, work directory, ...) that its owner or a global administrator
 * edits, and the personal settings (account, variables) each researcher edits for themselves.
 * Keys never do: the launcher makes them and publishes only their public halves.
 */

/** How a launcher logs in on an automatic site: one shared account, or each requester's own. */
export type SiteAccountMode = 'shared' | 'personal';
export const SITE_ACCOUNT_MODES: readonly SiteAccountMode[] = ['shared', 'personal'];

/** Who picks a Job's GPUs: the scheduler, or the runner from leaseGpuIds on a host without one. */
export type SiteGpuAssignment = 'scheduler' | 'lease';
export const SITE_GPU_ASSIGNMENTS: readonly SiteGpuAssignment[] = ['scheduler', 'lease'];

/** A job shell is a script, not data; a larger one is a mistake. */
export const MAX_JOB_SHELL_BYTES = 1024 * 1024;
/** known_hosts of a login host and its jump hosts. */
export const MAX_KNOWN_HOSTS_BYTES = 64 * 1024;
export const MAX_SITE_JUMP_HOSTS = 8;
/** MMT_VAR_<name> values of a site or of one person. */
export const MAX_SITE_VARIABLES = 64;
export const DEFAULT_SITE_SSH_PORT = 22;
export const DEFAULT_SITE_RUNNER_PYTHON = 'python3';
/** How long a stopped container may take to exit before the runner kills it. */
export const DEFAULT_SITE_CANCEL_GRACE_SECONDS = 10;
export const MAX_SITE_CANCEL_GRACE_SECONDS = 3600;
/** Outputs one Job may save (the worker's MMT_WORKER_MAX_OUTPUT_FILES). */
export const DEFAULT_SITE_MAX_OUTPUT_FILES = 10_000;
export const MAX_SITE_MAX_OUTPUT_FILES = 1_000_000;
/** Submissions a launcher claims for one site per poll (at most SITE_CLAIM_MAX_SUBMISSIONS). */
export const DEFAULT_SITE_MAX_ACTIVE_SUBMISSIONS = 10;
/** A connection check no launcher answered within this time fails. */
export const SITE_CONNECTION_CHECK_TIMEOUT_SECONDS = 5 * 60;

/*
 * Forms of the values the launcher hands to ssh and the job shell as separate arguments and
 * environment variables (never through a shell): the API enforces them and the Web checks them
 * first. They only keep each value a single token.
 */
export const MAX_SITE_HOST_LENGTH = 253;
/** A host must not start with "-" either (ssh would read it as an option). */
export const SITE_HOST_PATTERN = /^[A-Za-z0-9.:_-]+$/;
export const MAX_SITE_JUMP_HOST_LENGTH = 300;
/** [user@]host[:port], as ssh -J takes it. */
export const SITE_JUMP_HOST_PATTERN = /^(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9.-]+(?::\d{1,5})?$/;
/** POSIX-like account names, which every scheduler site uses. */
export const MAX_SITE_ACCOUNT_NAME_LENGTH = 64;
export const SITE_ACCOUNT_NAME_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;
/** The job shell's path rule (deploy/sites/README.md): letters, digits and ._/+@- only. */
export const MAX_SITE_PATH_LENGTH = 4000;
export const SITE_PATH_PATTERN = /^\/[A-Za-z0-9._/+@-]*$/;
/** runnerPython may also be a bare command such as python3. */
export const SITE_RUNNER_PYTHON_PATTERN = /^[A-Za-z0-9._/+@-]+$/;
export const MAX_SITE_CANCEL_COMMAND_LENGTH = 2000;
/** MMT_VAR_<name>: an environment variable name. */
export const MAX_SITE_VARIABLE_NAME_LENGTH = 64;
export const SITE_VARIABLE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const MAX_SITE_VARIABLE_VALUE_LENGTH = 1000;

/** Where the launcher logs in; automatic sites only. */
export interface SiteConnection {
  host: string;
  port: number;
  /** Hosts to pass through, in order, as [user@]host[:port]. */
  jumpHosts: string[];
  /** known_hosts lines of the host and every jump host; unknown host keys are never accepted. */
  knownHosts: string;
}

/** One version of a site's job shell. Versions never change; an edit adds the next one. */
export interface SiteJobShellSummary {
  id: string;
  targetId: string;
  version: number;
  sha256: string;
  sizeBytes: number;
  createdBy: string;
  createdByName: string | null;
  createdAt: string;
}

export interface SiteJobShell extends SiteJobShellSummary {
  content: string;
}

/** POST /targets/:id/job-shells: the next version, which every later submission uses. */
export interface SiteJobShellCreate {
  content: string;
}

/** A site's global settings, which its owner or a global administrator edits. */
export interface SiteSettings {
  /** The launcher that submits; automatic sites only. */
  launcherId: string | null;
  connection: SiteConnection | null;
  /** Manual sites are always 'personal': the person who runs `mado-tracking submit` submits. */
  accountMode: SiteAccountMode;
  /** The SSH user of an automatic site with a shared account; '' otherwise. */
  sharedAccount: string;
  /** Absolute directory on the site that compute nodes also see; a person may set their own. */
  workDirectory: string;
  runnerPython: string;
  /** The API as compute nodes reach it; null for the URL the launcher or submit uses. */
  runnerApiUrl: string | null;
  /** Removes a queued scheduler job; it reads MMT_SCHEDULER_JOB_ID. */
  cancelCommand: string | null;
  gpuAssignment: SiteGpuAssignment;
  /** GPUs a runner may lease on a host without a scheduler; [] for all of them. */
  leaseGpuIds: string[];
  /** MMT_VAR_<name> values for the job shell; a person's own variables override them. */
  variables: Record<string, string>;
  cancelGraceSeconds: number;
  maxOutputFiles: number;
  maxActiveSubmissions: number;
  /** The current job shell; null until one is saved. */
  jobShell: SiteJobShellSummary | null;
}

/** The global settings in a create or update; the job shell is saved separately (versioned). */
export type SiteSettingsInput = Partial<Omit<SiteSettings, 'jobShell'>>;

/**
 * GET/POST/PATCH /targets: a computer for those who may use or manage it. `site` is filled for its
 * owner and global administrators only; its users see what the computer is, not how it is reached.
 */
export interface ComputeTargetDetails extends ComputeTarget {
  ownerName: string | null;
  site: SiteSettings | null;
  /**
   * Sites: whose account their Jobs run as, for everyone who may use the computer, so they know
   * whether to save an account name; null for other computers.
   */
  siteAccountMode: SiteAccountMode | null;
}

/**
 * What POST /targets takes for a site beyond the ComputeTarget fields, and PATCH /targets/:id for
 * `site`. Whoever adds a computer owns it; a researcher who is not a global administrator adds
 * sites only.
 */
export interface ComputeTargetSiteFields {
  site?: SiteSettingsInput;
  /** The first job shell version. */
  jobShell?: string;
}

export type SiteKeyStatus = 'requested' | 'ready';
export const SITE_KEY_STATUSES: readonly SiteKeyStatus[] = ['requested', 'ready'];

/**
 * A key the launcher made for logging in on an automatic site. The private half stays on the
 * launcher's host; the public half is shown so the account's owner can authorize it on the site.
 */
export interface SiteKey {
  id: string;
  targetId: string;
  /** null: the shared account's key; otherwise this person's key for their own account. */
  userId: string | null;
  launcherId: string;
  status: SiteKeyStatus;
  /** The OpenSSH public key line (ssh-ed25519 …) once the launcher has made the key. */
  publicKey: string | null;
  /** SHA256:… as ssh-keygen -l prints it. */
  fingerprint: string | null;
  requestedAt: string;
  readyAt: string | null;
}

/** POST /targets/:id/keys/rotate: replace the shared key (personal=false) or one's own key. */
export interface SiteKeyRotate {
  personal: boolean;
}

/** A person's own settings for one site. */
export interface SitePersonalSettings {
  targetId: string;
  userId: string;
  userName: string | null;
  /** The SSH user an automatic personal site logs in as; '' on other sites. */
  accountName: string;
  /** Overrides the site's work directory. */
  workDirectory: string | null;
  /** On top of the site's variables. */
  variables: Record<string, string>;
  /** Automatic personal sites: the launcher's key for this person's account. */
  key: SiteKey | null;
  updatedAt: string;
}

/** GET /targets/:id/personal-settings/me: null until one saves settings for the site. */
export interface SitePersonalSettingsLookup {
  item: SitePersonalSettings | null;
}

/** PUT /targets/:id/personal-settings/me: one's own settings; omitted fields keep their value. */
export interface SitePersonalSettingsInput {
  accountName?: string;
  workDirectory?: string | null;
  variables?: Record<string, string>;
}

export type SiteConnectionCheckStatus = 'queued' | 'succeeded' | 'failed';
export const SITE_CONNECTION_CHECK_STATUSES: readonly SiteConnectionCheckStatus[] = [
  'queued',
  'succeeded',
  'failed',
];

/** The launcher logs in once with the key and account and runs `true`; nothing is submitted. */
export interface SiteConnectionCheck {
  id: string;
  targetId: string;
  /** null: the shared account; otherwise this person's account. */
  userId: string | null;
  requestedBy: string;
  status: SiteConnectionCheckStatus;
  /** What the launcher saw (the end of ssh's error), or why no launcher answered. */
  message: string | null;
  createdAt: string;
  finishedAt: string | null;
}

/** POST /targets/:id/connection-checks. */
export interface SiteConnectionCheckRequest {
  personal: boolean;
}

/**
 * A launcher registered on the Web. It authenticates with its own token and submits the Jobs of
 * the automatic sites assigned to it, whatever their Project.
 */
export interface Launcher {
  id: string;
  name: string;
  createdBy: string;
  createdAt: string;
  /** The last configuration read or claim; null before the first. */
  lastSeenAt: string | null;
  revokedAt: string | null;
  /** The first 12 characters of the current token; global administrators only. */
  tokenPrefix: string | null;
}

/** POST /launchers (global administrators). */
export interface LauncherCreate {
  name: string;
}

/** The token is shown once; the launcher reads it from its token file. */
export interface LauncherCreated {
  launcher: Launcher;
  token: string;
}

/** Whose account a job shell call runs as, with the work directory and variables for it. */
export interface SiteSubmissionAccount {
  mode: SiteAccountMode;
  /** The SSH user; '' for manual submissions, which run as whoever submits. */
  accountName: string;
  workDirectory: string;
  /** The site's variables with the person's own on top. */
  variables: Record<string, string>;
  /** The launcher key to log in with; null for manual submissions. */
  keyId: string | null;
}

export interface LauncherSite {
  target: ComputeTarget;
  settings: SiteSettings;
  jobShell: SiteJobShell | null;
}

/**
 * Every live key of this launcher: it makes the requested ones (PUT /launcher/keys/:id) and
 * deletes its local private keys that are no longer listed.
 */
export interface LauncherKey {
  id: string;
  targetId: string;
  userId: string | null;
  status: SiteKeyStatus;
  publicKey: string | null;
}

export interface LauncherConnectionCheck {
  id: string;
  targetId: string;
  account: SiteSubmissionAccount;
}

/**
 * GET /manual-submissions/sites/:targetId: what `mado-tracking submit` uses on a manual site,
 * with the caller's own account (work directory and variables).
 */
export interface ManualSiteConfiguration {
  target: ComputeTarget;
  settings: SiteSettings;
  jobShell: SiteJobShell | null;
  account: SiteSubmissionAccount;
}

/** GET /launcher/config: what the launcher needs for its next poll. */
export interface LauncherConfiguration {
  launcher: { id: string; name: string };
  sites: LauncherSite[];
  keys: LauncherKey[];
  checks: LauncherConnectionCheck[];
}

/** PUT /launcher/keys/:id. */
export interface LauncherKeyPublish {
  publicKey: string;
}

/** POST /launcher/connection-checks/:id. */
export interface LauncherConnectionCheckResult {
  outcome: 'succeeded' | 'failed';
  message?: string | null;
}
