import { z } from 'zod';
import type {
  JobArrayCreated,
  JobArrayGroup,
  ManualSubmissionWaiting,
  RunnerFinishResult,
  RunnerState,
  SiteSchedulerCancellation,
  SiteSubmission,
} from '../index.js';
import { computeTargetSchema, jobSchema } from './execution.js';
import { idSchema, timestampSchema } from './primitives.js';
import { namedContractSchema } from './schemaRegistry.js';
import {
  siteJobShellSchema,
  siteSettingsSchema,
  siteSubmissionAccountSchema,
} from './siteComputers.js';
import type { Expect, MutuallyAssignable } from './typeAssertions.js';
import { workerJobSchema } from './workerJobs.js';

export const jobArrayGroupSchema = namedContractSchema(
  'JobArrayGroup',
  z.strictObject({
    id: idSchema,
    projectId: idSchema,
    targetId: idSchema,
    size: z.number().int(),
    createdBy: idSchema,
    parentJobId: idSchema.nullable(),
    hookId: idSchema.nullable(),
    finishedAt: timestampSchema.nullable(),
    createdAt: timestampSchema,
  }),
);
export const jobArrayCreatedSchema = namedContractSchema(
  'JobArrayCreated',
  z.strictObject({ arrayGroup: jobArrayGroupSchema, jobs: z.array(jobSchema) }),
);
export const siteSubmissionSchema = namedContractSchema(
  'SiteSubmission',
  z.strictObject({
    target: computeTargetSchema,
    arrayGroupId: idSchema.nullable(),
    requester: z.strictObject({ id: idSchema, email: z.string(), username: z.string().nullable() }),
    jobs: z.array(workerJobSchema),
    settings: siteSettingsSchema,
    jobShell: siteJobShellSchema,
    account: siteSubmissionAccountSchema,
  }),
);
export const manualSubmissionWaitingSchema = namedContractSchema(
  'ManualSubmissionWaiting',
  z.strictObject({
    targetId: idSchema,
    targetName: z.string(),
    waitingJobs: z.number().int(),
    allWaitingJobs: z.number().int().nullable(),
  }),
);
export const siteSchedulerCancellationSchema = namedContractSchema(
  'SiteSchedulerCancellation',
  z.strictObject({
    jobId: idSchema,
    targetId: idSchema,
    schedulerJobId: z.string(),
    account: siteSubmissionAccountSchema,
  }),
);
export const runnerStateSchema = namedContractSchema(
  'RunnerState',
  z.strictObject({ job: jobSchema, cancelRequested: z.boolean() }),
);
export const runnerFinishResultSchema = namedContractSchema(
  'RunnerFinishResult',
  z.strictObject({ job: jobSchema, retryJobId: idSchema.nullable() }),
);

type _JobArrayGroup = Expect<MutuallyAssignable<z.infer<typeof jobArrayGroupSchema>, JobArrayGroup>>;
type _JobArrayCreated = Expect<
  MutuallyAssignable<z.infer<typeof jobArrayCreatedSchema>, JobArrayCreated>
>;
type _SiteSubmission = Expect<MutuallyAssignable<z.infer<typeof siteSubmissionSchema>, SiteSubmission>>;
type _ManualSubmissionWaiting = Expect<
  MutuallyAssignable<z.infer<typeof manualSubmissionWaitingSchema>, ManualSubmissionWaiting>
>;
type _SiteSchedulerCancellation = Expect<
  MutuallyAssignable<z.infer<typeof siteSchedulerCancellationSchema>, SiteSchedulerCancellation>
>;
type _RunnerState = Expect<MutuallyAssignable<z.infer<typeof runnerStateSchema>, RunnerState>>;
type _RunnerFinishResult = Expect<
  MutuallyAssignable<z.infer<typeof runnerFinishResultSchema>, RunnerFinishResult>
>;
