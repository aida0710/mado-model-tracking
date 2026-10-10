import { z } from 'zod';
import {
  DEFAULT_SITE_CANCEL_GRACE_SECONDS,
  DEFAULT_SITE_MAX_ACTIVE_SUBMISSIONS,
  DEFAULT_SITE_MAX_OUTPUT_FILES,
  DEFAULT_SITE_RUNNER_PYTHON,
  DEFAULT_SITE_SSH_PORT,
  MAX_JOB_SHELL_BYTES,
  MAX_KNOWN_HOSTS_BYTES,
  MAX_SITE_ACCOUNT_NAME_LENGTH,
  MAX_SITE_CANCEL_COMMAND_LENGTH,
  MAX_SITE_CANCEL_GRACE_SECONDS,
  MAX_SITE_HOST_LENGTH,
  MAX_SITE_JUMP_HOST_LENGTH,
  MAX_SITE_JUMP_HOSTS,
  MAX_SITE_MAX_OUTPUT_FILES,
  MAX_SITE_PATH_LENGTH,
  MAX_SITE_VARIABLE_NAME_LENGTH,
  MAX_SITE_VARIABLE_VALUE_LENGTH,
  MAX_SITE_VARIABLES,
  SITE_ACCOUNT_MODES,
  SITE_ACCOUNT_NAME_PATTERN,
  SITE_CLAIM_MAX_SUBMISSIONS,
  SITE_GPU_ASSIGNMENTS,
  SITE_HOST_PATTERN,
  SITE_JUMP_HOST_PATTERN,
  SITE_PATH_PATTERN,
  SITE_RUNNER_PYTHON_PATTERN,
  SITE_VARIABLE_NAME_PATTERN,
  type ComputeTarget,
  type SiteSettings,
} from '@mmt/contracts';
import { DomainError } from './errors.js';
import {
  gpuIdsSchema,
  nameSchema,
  targetPatchSchema,
  targetSchema,
  uniqueIdsSchema,
  uuidSchema,
} from './validation.js';

// The forms are in contracts (the Web checks them first).
const SINGLE_LINE = /^[^\r\n\0]*$/;
// The anchored form, or '' for an unset value.
const formOrEmpty = (form: RegExp) => new RegExp(`^(?:${form.source.replace(/^\^|\$$/g, '')})?$`);
const hostSchema = z
  .string()
  .min(1)
  .max(MAX_SITE_HOST_LENGTH)
  .regex(SITE_HOST_PATTERN)
  .refine((value) => !value.startsWith('-'), 'A host must not start with "-"');
const jumpHostSchema = z.string().max(MAX_SITE_JUMP_HOST_LENGTH).regex(SITE_JUMP_HOST_PATTERN);
export const siteAccountNameSchema = z
  .string()
  .max(MAX_SITE_ACCOUNT_NAME_LENGTH)
  .regex(formOrEmpty(SITE_ACCOUNT_NAME_PATTERN));
const sitePathSchema = z
  .string()
  .max(MAX_SITE_PATH_LENGTH)
  .regex(formOrEmpty(SITE_PATH_PATTERN), 'An absolute path of letters, digits and ._/+@- only');
const runnerPythonSchema = z.string().min(1).max(MAX_SITE_PATH_LENGTH).regex(SITE_RUNNER_PYTHON_PATTERN);
const runnerApiUrlSchema = z
  .url({ protocol: /^https?$/ })
  .max(2000);
const cancelCommandSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_SITE_CANCEL_COMMAND_LENGTH)
  .regex(SINGLE_LINE);
const variableNameSchema = z.string().max(MAX_SITE_VARIABLE_NAME_LENGTH).regex(SITE_VARIABLE_NAME_PATTERN);
export const siteVariablesSchema = z
  .record(variableNameSchema, z.string().max(MAX_SITE_VARIABLE_VALUE_LENGTH).regex(SINGLE_LINE))
  .refine((values) => Object.keys(values).length <= MAX_SITE_VARIABLES, {
    message: `At most ${MAX_SITE_VARIABLES} variables`,
  });
const knownHostsSchema = z
  .string()
  .refine((value) => Buffer.byteLength(value) <= MAX_KNOWN_HOSTS_BYTES, 'known_hosts is too large')
  .refine((value) => !value.includes('\0'), 'known_hosts must be text')
  .refine(
    (value) =>
      value
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('#'))
        .every((line) => line.split(/\s+/).length >= 3),
    'Each known_hosts line is "<hosts> <key type> <key>"',
  );

export const siteConnectionInputSchema = z.strictObject({
  host: hostSchema,
  port: z.number().int().min(1).max(65535).default(DEFAULT_SITE_SSH_PORT),
  jumpHosts: z.array(jumpHostSchema).max(MAX_SITE_JUMP_HOSTS).default([]),
  knownHosts: knownHostsSchema,
});

export const siteSettingsInputSchema = z.strictObject({
  launcherId: uuidSchema.nullable().optional(),
  connection: siteConnectionInputSchema.nullable().optional(),
  accountMode: z.enum(SITE_ACCOUNT_MODES).optional(),
  sharedAccount: siteAccountNameSchema.optional(),
  workDirectory: sitePathSchema.optional(),
  runnerPython: runnerPythonSchema.optional(),
  runnerApiUrl: runnerApiUrlSchema.nullable().optional(),
  cancelCommand: cancelCommandSchema.nullable().optional(),
  gpuAssignment: z.enum(SITE_GPU_ASSIGNMENTS).optional(),
  leaseGpuIds: gpuIdsSchema.optional(),
  variables: siteVariablesSchema.optional(),
  cancelGraceSeconds: z.number().positive().max(MAX_SITE_CANCEL_GRACE_SECONDS).optional(),
  maxOutputFiles: z.number().int().min(1).max(MAX_SITE_MAX_OUTPUT_FILES).optional(),
  maxActiveSubmissions: z.number().int().min(1).max(SITE_CLAIM_MAX_SUBMISSIONS).optional(),
});
export type SiteSettingsInputValues = z.infer<typeof siteSettingsInputSchema>;

export const jobShellContentSchema = z
  .string()
  .refine((value) => value.length > 0, 'The job shell is empty')
  .refine(
    (value) => Buffer.byteLength(value) <= MAX_JOB_SHELL_BYTES,
    `A job shell is at most ${MAX_JOB_SHELL_BYTES} bytes`,
  )
  .refine((value) => !value.includes('\0'), 'A job shell is text');
export const siteJobShellCreateSchema = z.strictObject({ content: jobShellContentSchema });

export const sitePersonalSettingsInputSchema = z.strictObject({
  accountName: siteAccountNameSchema.optional(),
  workDirectory: sitePathSchema.nullable().optional(),
  variables: siteVariablesSchema.optional(),
});
export const computeTargetSharingSchema = z.strictObject({ projectIds: uniqueIdsSchema.max(100) });
export const siteKeyRotateSchema = z.strictObject({ personal: z.boolean() });
export const siteConnectionCheckRequestSchema = z.strictObject({ personal: z.boolean() });
export const siteConnectionCheckQuerySchema = z.strictObject({
  personal: z.enum(['true', 'false']).default('false'),
});

export const launcherCreateSchema = z.strictObject({ name: nameSchema });
export const launcherKeyPublishSchema = z.strictObject({ publicKey: z.string().min(1).max(8192) });
export const launcherConnectionCheckResultSchema = z.strictObject({
  outcome: z.enum(['succeeded', 'failed']),
  message: z.string().max(2000).nullish(),
});

/** A site's settings without the job shell, which is versioned on its own. */
export type SiteSettingsValues = Omit<SiteSettings, 'jobShell'>;

export const DEFAULT_SITE_SETTINGS: SiteSettingsValues = {
  launcherId: null,
  connection: null,
  accountMode: 'personal',
  sharedAccount: '',
  workDirectory: '',
  runnerPython: DEFAULT_SITE_RUNNER_PYTHON,
  runnerApiUrl: null,
  cancelCommand: null,
  gpuAssignment: 'scheduler',
  leaseGpuIds: [],
  variables: {},
  cancelGraceSeconds: DEFAULT_SITE_CANCEL_GRACE_SECONDS,
  maxOutputFiles: DEFAULT_SITE_MAX_OUTPUT_FILES,
  maxActiveSubmissions: DEFAULT_SITE_MAX_ACTIVE_SUBMISSIONS,
};

/** The stored settings with the given fields replaced. */
export function mergeSiteSettings(
  previous: SiteSettingsValues,
  input: SiteSettingsInputValues,
): SiteSettingsValues {
  const defined = Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined),
  ) as Partial<SiteSettingsValues>;
  return { ...previous, ...defined };
}

function invalidSettings(message: string): never {
  throw new DomainError(422, message, 'site_settings_invalid');
}

/**
 * What a launcher or `mado-tracking submit` needs from a site of this submission mode. A manual
 * site runs as whoever submits, so it names no launcher, connection or shared account.
 */
export function validateSiteSettings(
  target: Pick<ComputeTarget, 'submissionMode'>,
  settings: SiteSettingsValues,
): void {
  if (target.submissionMode === 'automatic') {
    if (!settings.launcherId) invalidSettings('自動投入のsiteには投入するlauncherが必要です');
    if (!settings.connection) invalidSettings('自動投入のsiteには接続先（host）が必要です');
    if (!settings.connection.knownHosts.trim())
      invalidSettings('接続先と経由するホストのknown_hostsが必要です');
    if (settings.accountMode === 'shared' && !settings.sharedAccount)
      invalidSettings('共用アカウントのsiteにはアカウント名が必要です');
    if (settings.accountMode === 'personal' && settings.sharedAccount)
      invalidSettings('本人のアカウントで投入するsiteには共用アカウント名を入れません');
  } else {
    if (settings.launcherId || settings.connection || settings.sharedAccount)
      invalidSettings('手動投入のsiteにはlauncher・接続先・共用アカウントを入れません');
    if (settings.accountMode !== 'personal')
      invalidSettings('手動投入のsiteは投入した本人のアカウントで動きます（accountMode personal）');
  }
  if (settings.accountMode === 'shared' && !settings.workDirectory)
    invalidSettings('共用アカウントのsiteには作業ディレクトリが必要です');
  if (settings.gpuAssignment === 'scheduler' && settings.leaseGpuIds.length)
    invalidSettings('選んでよいGPUは、runnerがGPUを選ぶ（lease）siteだけに入れます');
}

// POST /targets and PATCH /targets/:id take a site's settings with the ComputeTarget fields.
export const targetCreateSchema = targetSchema.extend({
  site: siteSettingsInputSchema.optional(),
  personal: z.boolean().optional(),
  projectIds: uniqueIdsSchema.max(100).optional(),
  jobShell: jobShellContentSchema.optional(),
});
export const targetUpdateSchema = targetPatchSchema.extend({
  site: siteSettingsInputSchema.optional(),
});
export const targetListQuerySchema = z.strictObject({ projectId: uuidSchema.optional() });
