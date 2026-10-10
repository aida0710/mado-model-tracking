import {
  DEFAULT_SITE_CANCEL_GRACE_SECONDS,
  DEFAULT_SITE_MAX_ACTIVE_SUBMISSIONS,
  DEFAULT_SITE_MAX_OUTPUT_FILES,
  DEFAULT_SITE_RUNNER_PYTHON,
  DEFAULT_SITE_SSH_PORT,
  MAX_KNOWN_HOSTS_BYTES,
  MAX_SITE_ACCOUNT_NAME_LENGTH,
  MAX_SITE_CANCEL_GRACE_SECONDS,
  MAX_SITE_HOST_LENGTH,
  MAX_SITE_JUMP_HOSTS,
  MAX_SITE_MAX_OUTPUT_FILES,
  SITE_ACCOUNT_MODES,
  SITE_ACCOUNT_NAME_PATTERN,
  SITE_CLAIM_MAX_SUBMISSIONS,
  SITE_GPU_ASSIGNMENTS,
  SITE_HOST_PATTERN,
  SITE_JUMP_HOST_PATTERN,
  SITE_PATH_PATTERN,
  SITE_RUNNER_PYTHON_PATTERN,
  type SiteAccountMode,
  type SiteConnection,
  type SiteGpuAssignment,
  type SiteSettings,
} from '@mmt/contracts';
import type { FormValues } from '../types/form';
import { getFieldValue, parseChoice, splitLines } from './formValues';
import { formatSiteVariables, parseSiteVariables } from './siteVariables';
import { text } from '../i18n/catalog';
import { siteComputersTextTemplates } from '../i18n/siteComputers';

/** Every global setting of a site; the job shell is saved on its own, as a new version. */
export type SiteSettingsValues = Omit<SiteSettings, 'jobShell'>;

const MAX_PORT = 65535;
const BYTES_PER_KIB = 1024;
// The API's rules (the forms in contracts), checked here first to explain them in the form.
// A known_hosts line is "<hosts> <key type> <key>"; lines starting with # are comments.
const KNOWN_HOSTS_LINE_FIELDS = 3;
// Many people log in to a supercomputer with their own account, so a new site starts that way.
const DEFAULT_ACCOUNT_MODE: SiteAccountMode = 'personal';
const DEFAULT_GPU_ASSIGNMENT: SiteGpuAssignment = 'scheduler';

/** The form values of a site's global settings; a new site (null) starts from the API defaults. */
export function siteSettingsFormValues(site: SiteSettings | null): FormValues {
  const connection = site?.connection;
  return {
    launcherId: site?.launcherId ?? '',
    siteHost: connection?.host ?? '',
    sitePort: String(connection?.port ?? DEFAULT_SITE_SSH_PORT),
    siteJumpHosts: connection?.jumpHosts.join('\n') ?? '',
    siteKnownHosts: connection?.knownHosts ?? '',
    accountMode: site?.accountMode ?? DEFAULT_ACCOUNT_MODE,
    sharedAccount: site?.sharedAccount ?? '',
    siteWorkDirectory: site?.workDirectory ?? '',
    runnerPython: site?.runnerPython ?? DEFAULT_SITE_RUNNER_PYTHON,
    runnerApiUrl: site?.runnerApiUrl ?? '',
    cancelCommand: site?.cancelCommand ?? '',
    gpuAssignment: site?.gpuAssignment ?? DEFAULT_GPU_ASSIGNMENT,
    leaseGpuIds: site?.leaseGpuIds.join('\n') ?? '',
    siteVariables: formatSiteVariables(site?.variables ?? {}),
    maxActiveSubmissions: String(site?.maxActiveSubmissions ?? DEFAULT_SITE_MAX_ACTIVE_SUBMISSIONS),
    cancelGraceSeconds: String(site?.cancelGraceSeconds ?? DEFAULT_SITE_CANCEL_GRACE_SECONDS),
    maxOutputFiles: String(site?.maxOutputFiles ?? DEFAULT_SITE_MAX_OUTPUT_FILES),
  };
}

function parseIntegerInRange(value: string, label: string, min: number, max: number): number {
  const number = Number(value.trim());
  if (!value.trim() || !Number.isSafeInteger(number) || number < min || number > max)
    throw new Error(siteComputersTextTemplates.siteNumberRangeError(label, min, max));
  return number;
}

/** A shared account or one's own account name on the site, as the launcher logs in with it. */
export function parseAccountName(value: string, requiredMessage: string): string {
  const name = value.trim();
  if (!name) throw new Error(requiredMessage);
  if (name.length > MAX_SITE_ACCOUNT_NAME_LENGTH || !SITE_ACCOUNT_NAME_PATTERN.test(name))
    throw new Error(text.siteAccountNameError);
  return name;
}

/** An absolute directory on the site; empty leaves it to the other setting (site or person). */
export function parseSiteDirectory(value: string): string {
  const directory = value.trim();
  if (directory && !SITE_PATH_PATTERN.test(directory)) throw new Error(text.siteWorkDirectoryError);
  return directory;
}

function parseRunnerPython(value: string): string {
  const runnerPython = value.trim();
  if (!runnerPython) throw new Error(text.required);
  if (!SITE_RUNNER_PYTHON_PATTERN.test(runnerPython)) throw new Error(text.runnerPythonError);
  return runnerPython;
}

function parseRunnerApiUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(text.runnerApiUrlError);
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw new Error(text.runnerApiUrlError);
  return trimmed;
}

function parseKnownHosts(value: string): string {
  const knownHosts = value.trim();
  if (!knownHosts) throw new Error(text.siteKnownHostsRequired);
  const entries = knownHosts
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
  if (entries.some((line) => line.split(/\s+/).length < KNOWN_HOSTS_LINE_FIELDS))
    throw new Error(text.siteKnownHostsLineError);
  const stored = `${knownHosts}\n`;
  if (new TextEncoder().encode(stored).length > MAX_KNOWN_HOSTS_BYTES)
    throw new Error(
      siteComputersTextTemplates.siteKnownHostsTooLarge(MAX_KNOWN_HOSTS_BYTES / BYTES_PER_KIB),
    );
  return stored;
}

function parseConnection(values: FormValues): SiteConnection {
  const host = getFieldValue(values, 'siteHost').trim();
  if (host.length > MAX_SITE_HOST_LENGTH || !SITE_HOST_PATTERN.test(host) || host.startsWith('-'))
    throw new Error(text.siteHostError);
  const jumpHosts = splitLines(getFieldValue(values, 'siteJumpHosts'));
  const invalidJumpHost = jumpHosts.find((jumpHost) => !SITE_JUMP_HOST_PATTERN.test(jumpHost));
  if (invalidJumpHost !== undefined)
    throw new Error(siteComputersTextTemplates.siteJumpHostError(invalidJumpHost));
  if (jumpHosts.length > MAX_SITE_JUMP_HOSTS)
    throw new Error(siteComputersTextTemplates.siteJumpHostsTooMany(MAX_SITE_JUMP_HOSTS));
  return {
    host,
    port: parseIntegerInRange(getFieldValue(values, 'sitePort'), text.sitePort, 1, MAX_PORT),
    jumpHosts,
    knownHosts: parseKnownHosts(getFieldValue(values, 'siteKnownHosts')),
  };
}

function parseLauncherId(values: FormValues): string {
  const launcherId = getFieldValue(values, 'launcherId');
  if (!launcherId) throw new Error(text.siteLauncherRequired);
  return launcherId;
}

/**
 * A site's global settings from the form. An automatic site needs the launcher that submits and
 * where it logs in; a manual site has neither, nor a shared account, since whoever runs
 * `mado-tracking submit` submits as themselves. A shared account runs everyone's Jobs in the
 * site's own work directory. Only a host without a scheduler (gpuAssignment 'lease') keeps the GPUs
 * its runners may choose from.
 */
export function buildSiteSettingsInput(values: FormValues): SiteSettingsValues {
  const isAutomatic = getFieldValue(values, 'submissionMode') === 'automatic';
  const accountMode = isAutomatic
    ? parseChoice(getFieldValue(values, 'accountMode'), SITE_ACCOUNT_MODES)
    : 'personal';
  const gpuAssignment = parseChoice(getFieldValue(values, 'gpuAssignment'), SITE_GPU_ASSIGNMENTS);
  const workDirectory = parseSiteDirectory(getFieldValue(values, 'siteWorkDirectory'));
  if (accountMode === 'shared' && !workDirectory) throw new Error(text.siteWorkDirectoryRequired);
  return {
    launcherId: isAutomatic ? parseLauncherId(values) : null,
    connection: isAutomatic ? parseConnection(values) : null,
    accountMode,
    sharedAccount:
      accountMode === 'shared'
        ? parseAccountName(getFieldValue(values, 'sharedAccount'), text.siteSharedAccountRequired)
        : '',
    workDirectory,
    runnerPython: parseRunnerPython(getFieldValue(values, 'runnerPython')),
    runnerApiUrl: parseRunnerApiUrl(getFieldValue(values, 'runnerApiUrl')),
    cancelCommand: getFieldValue(values, 'cancelCommand').trim() || null,
    gpuAssignment,
    leaseGpuIds: gpuAssignment === 'lease' ? splitLines(getFieldValue(values, 'leaseGpuIds')) : [],
    variables: parseSiteVariables(getFieldValue(values, 'siteVariables')),
    maxActiveSubmissions: parseIntegerInRange(
      getFieldValue(values, 'maxActiveSubmissions'),
      text.maxActiveSubmissions,
      1,
      SITE_CLAIM_MAX_SUBMISSIONS,
    ),
    cancelGraceSeconds: parseIntegerInRange(
      getFieldValue(values, 'cancelGraceSeconds'),
      text.cancelGraceSeconds,
      1,
      MAX_SITE_CANCEL_GRACE_SECONDS,
    ),
    maxOutputFiles: parseIntegerInRange(
      getFieldValue(values, 'maxOutputFiles'),
      text.maxOutputFiles,
      1,
      MAX_SITE_MAX_OUTPUT_FILES,
    ),
  };
}
