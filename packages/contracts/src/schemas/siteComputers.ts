import { z } from 'zod';
import type {
  ComputeTargetDetails,
  Launcher,
  LauncherConfiguration,
  LauncherCreated,
  ManualSiteConfiguration,
  ShareableProject,
  SiteConnectionCheck,
  SiteJobShell,
  SiteJobShellSummary,
  SiteKey,
  SitePersonalSettings,
  SiteSettings,
  SiteSubmissionAccount,
} from '../index.js';
import {
  SITE_ACCOUNT_MODES,
  SITE_CONNECTION_CHECK_STATUSES,
  SITE_GPU_ASSIGNMENTS,
  SITE_KEY_STATUSES,
} from '../siteComputers.js';
import { computeTargetSchema } from './execution.js';
import { idSchema, timestampSchema } from './primitives.js';
import { namedContractSchema } from './schemaRegistry.js';
import type { Expect, MutuallyAssignable } from './typeAssertions.js';

export const siteAccountModeSchema = z.enum(SITE_ACCOUNT_MODES);
export const siteGpuAssignmentSchema = z.enum(SITE_GPU_ASSIGNMENTS);
const siteVariablesSchema = z.record(z.string(), z.string());

export const siteConnectionSchema = z.strictObject({
  host: z.string(),
  port: z.number().int(),
  jumpHosts: z.array(z.string()),
  knownHosts: z.string(),
});
export const siteJobShellSummarySchema = namedContractSchema(
  'SiteJobShellSummary',
  z.strictObject({
    id: idSchema,
    targetId: idSchema,
    version: z.number().int(),
    sha256: z.string(),
    sizeBytes: z.number().int(),
    createdBy: idSchema,
    createdByName: z.string().nullable(),
    createdAt: timestampSchema,
  }),
);
export const siteJobShellSchema = namedContractSchema(
  'SiteJobShell',
  siteJobShellSummarySchema.extend({ content: z.string() }),
);
export const siteSettingsSchema = namedContractSchema(
  'SiteSettings',
  z.strictObject({
    launcherId: idSchema.nullable(),
    connection: siteConnectionSchema.nullable(),
    accountMode: siteAccountModeSchema,
    sharedAccount: z.string(),
    workDirectory: z.string(),
    runnerPython: z.string(),
    runnerApiUrl: z.string().nullable(),
    cancelCommand: z.string().nullable(),
    gpuAssignment: siteGpuAssignmentSchema,
    leaseGpuIds: z.array(z.string()),
    variables: siteVariablesSchema,
    cancelGraceSeconds: z.number(),
    maxOutputFiles: z.number().int(),
    maxActiveSubmissions: z.number().int(),
    jobShell: siteJobShellSummarySchema.nullable(),
  }),
);
export const computeTargetDetailsSchema = namedContractSchema(
  'ComputeTargetDetails',
  computeTargetSchema.extend({
    ownerName: z.string().nullable(),
    projectIds: z.array(idSchema),
    site: siteSettingsSchema.nullable(),
    siteAccountMode: siteAccountModeSchema.nullable(),
  }),
);
export const shareableProjectSchema = namedContractSchema(
  'ShareableProject',
  z.strictObject({ id: idSchema, name: z.string() }),
);
export const siteKeySchema = namedContractSchema(
  'SiteKey',
  z.strictObject({
    id: idSchema,
    targetId: idSchema,
    userId: idSchema.nullable(),
    launcherId: idSchema,
    status: z.enum(SITE_KEY_STATUSES),
    publicKey: z.string().nullable(),
    fingerprint: z.string().nullable(),
    requestedAt: timestampSchema,
    readyAt: timestampSchema.nullable(),
  }),
);
export const sitePersonalSettingsSchema = namedContractSchema(
  'SitePersonalSettings',
  z.strictObject({
    targetId: idSchema,
    userId: idSchema,
    userName: z.string().nullable(),
    accountName: z.string(),
    workDirectory: z.string().nullable(),
    variables: siteVariablesSchema,
    key: siteKeySchema.nullable(),
    updatedAt: timestampSchema,
  }),
);
export const siteConnectionCheckSchema = namedContractSchema(
  'SiteConnectionCheck',
  z.strictObject({
    id: idSchema,
    targetId: idSchema,
    userId: idSchema.nullable(),
    requestedBy: idSchema,
    status: z.enum(SITE_CONNECTION_CHECK_STATUSES),
    message: z.string().nullable(),
    createdAt: timestampSchema,
    finishedAt: timestampSchema.nullable(),
  }),
);
export const launcherSchema = namedContractSchema(
  'Launcher',
  z.strictObject({
    id: idSchema,
    name: z.string(),
    createdBy: idSchema,
    createdAt: timestampSchema,
    lastSeenAt: timestampSchema.nullable(),
    revokedAt: timestampSchema.nullable(),
    tokenPrefix: z.string().nullable(),
  }),
);
export const launcherCreatedSchema = namedContractSchema(
  'LauncherCreated',
  z.strictObject({ launcher: launcherSchema, token: z.string() }),
);
export const siteSubmissionAccountSchema = namedContractSchema(
  'SiteSubmissionAccount',
  z.strictObject({
    mode: siteAccountModeSchema,
    accountName: z.string(),
    workDirectory: z.string(),
    variables: siteVariablesSchema,
    keyId: idSchema.nullable(),
  }),
);
export const manualSiteConfigurationSchema = namedContractSchema(
  'ManualSiteConfiguration',
  z.strictObject({
    target: computeTargetSchema,
    settings: siteSettingsSchema,
    jobShell: siteJobShellSchema.nullable(),
    account: siteSubmissionAccountSchema,
  }),
);
export const launcherConfigurationSchema = namedContractSchema(
  'LauncherConfiguration',
  z.strictObject({
    launcher: z.strictObject({ id: idSchema, name: z.string() }),
    sites: z.array(
      z.strictObject({
        target: computeTargetSchema,
        settings: siteSettingsSchema,
        jobShell: siteJobShellSchema.nullable(),
      }),
    ),
    keys: z.array(
      z.strictObject({
        id: idSchema,
        targetId: idSchema,
        userId: idSchema.nullable(),
        status: z.enum(SITE_KEY_STATUSES),
        publicKey: z.string().nullable(),
      }),
    ),
    checks: z.array(
      z.strictObject({ id: idSchema, targetId: idSchema, account: siteSubmissionAccountSchema }),
    ),
  }),
);

type _SiteJobShellSummary = Expect<
  MutuallyAssignable<z.infer<typeof siteJobShellSummarySchema>, SiteJobShellSummary>
>;
type _SiteJobShell = Expect<MutuallyAssignable<z.infer<typeof siteJobShellSchema>, SiteJobShell>>;
type _SiteSettings = Expect<MutuallyAssignable<z.infer<typeof siteSettingsSchema>, SiteSettings>>;
type _ComputeTargetDetails = Expect<
  MutuallyAssignable<z.infer<typeof computeTargetDetailsSchema>, ComputeTargetDetails>
>;
type _ShareableProject = Expect<
  MutuallyAssignable<z.infer<typeof shareableProjectSchema>, ShareableProject>
>;
type _SiteKey = Expect<MutuallyAssignable<z.infer<typeof siteKeySchema>, SiteKey>>;
type _SitePersonalSettings = Expect<
  MutuallyAssignable<z.infer<typeof sitePersonalSettingsSchema>, SitePersonalSettings>
>;
type _SiteConnectionCheck = Expect<
  MutuallyAssignable<z.infer<typeof siteConnectionCheckSchema>, SiteConnectionCheck>
>;
type _Launcher = Expect<MutuallyAssignable<z.infer<typeof launcherSchema>, Launcher>>;
type _LauncherCreated = Expect<
  MutuallyAssignable<z.infer<typeof launcherCreatedSchema>, LauncherCreated>
>;
type _SiteSubmissionAccount = Expect<
  MutuallyAssignable<z.infer<typeof siteSubmissionAccountSchema>, SiteSubmissionAccount>
>;
type _LauncherConfiguration = Expect<
  MutuallyAssignable<z.infer<typeof launcherConfigurationSchema>, LauncherConfiguration>
>;
type _ManualSiteConfiguration = Expect<
  MutuallyAssignable<z.infer<typeof manualSiteConfigurationSchema>, ManualSiteConfiguration>
>;
