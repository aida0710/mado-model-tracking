import { z } from 'zod';
import { MAX_JOB_ARRAY_SIZE, SITE_CLAIM_MAX_SUBMISSIONS } from '@mmt/contracts';
import {
  gpuCountSchema,
  gpuIdsSchema,
  jsonObjectSchema,
  logBatchSchema,
  maxAttemptsSchema,
  metricBatchSchema,
  nameSchema,
  runKindSchema,
  tagsSchema,
  uniqueIdsSchema,
  uuidSchema,
  walltimeSecondsSchema,
} from './validation.js';
import { outputDeclarationsSchema } from './workerOutputValidation.js';

// Chosen by the launcher or `mado-tracking submit`, like a worker's workerId.
const holderIdSchema = z.string().min(1).max(200);
const claimLimitSchema = z
  .number()
  .int()
  .min(1)
  .max(SITE_CLAIM_MAX_SUBMISSIONS)
  .default(SITE_CLAIM_MAX_SUBMISSIONS);
// An array is reported as one submission, so a result may name every member.
const submissionJobIdsSchema = z
  .array(uuidSchema)
  .min(1)
  .max(MAX_JOB_ARRAY_SIZE)
  .refine((values) => new Set(values).size === values.length, 'IDs must be unique');
// What the job shell printed as the scheduler's job ID (qsub, sbatch, pjsub).
const schedulerJobIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), 'Control characters are not allowed');
const submissionResultSchema = z.strictObject({
  jobIds: submissionJobIdsSchema,
  outcome: z.enum(['submitted', 'failed']),
  schedulerJobId: schedulerJobIdSchema.nullish(),
  error: z.string().max(20000).nullish(),
});
const submissionResultsSchema = z.array(submissionResultSchema).min(1).max(SITE_CLAIM_MAX_SUBMISSIONS);

export const siteSubmissionClaimSchema = z.strictObject({
  launcherId: holderIdSchema,
  targetIds: uniqueIdsSchema.optional(),
  limit: claimLimitSchema,
});
export const siteSubmissionReportSchema = z.strictObject({
  launcherId: holderIdSchema,
  results: submissionResultsSchema,
});
export const siteCancellationQuerySchema = z.strictObject({
  launcherId: holderIdSchema,
  targetIds: uniqueIdsSchema.optional(),
});
export const siteCancellationReportSchema = z.strictObject({
  launcherId: holderIdSchema,
  jobIds: uniqueIdsSchema.min(1),
});
export const manualSubmissionClaimSchema = z.strictObject({
  targetId: uuidSchema,
  submitterId: holderIdSchema,
  limit: claimLimitSchema,
});
export const manualSubmissionReportSchema = z.strictObject({
  submitterId: holderIdSchema,
  results: submissionResultsSchema,
});

export const jobArrayCreateSchema = z.strictObject({
  experimentId: uuidSchema,
  name: nameSchema,
  kind: runKindSchema,
  codeVersionId: uuidSchema,
  modelVersionId: uuidSchema.nullable().default(null),
  inputDatasetVersionIds: uniqueIdsSchema.default([]),
  parameters: jsonObjectSchema.default({}),
  tags: tagsSchema.default({}),
  targetId: uuidSchema,
  gpuCount: gpuCountSchema.default(0),
  walltimeSeconds: walltimeSecondsSchema.nullable().default(null),
  size: z.number().int().min(1).max(MAX_JOB_ARRAY_SIZE),
  maxAttempts: maxAttemptsSchema,
  retryOnFailure: z.boolean().default(false),
  retryOnTimeout: z.boolean().default(false),
  allowChildJobs: z.boolean().default(false),
  datasetPartitionVersionId: uuidSchema.nullable().default(null),
});

// The runner picks its instance ID once (uuid4) and sends it with every report.
const runnerPhaseSchema = z.enum(['waiting_resources', 'running']);
// The host name the compute node reports, for display (jobs.runner_host).
const runnerHostSchema = z.string().trim().min(1).max(253);
export const runnerStartSchema = z.strictObject({
  instanceId: uuidSchema,
  host: runnerHostSchema,
  gpuIds: gpuIdsSchema.default([]),
  phase: runnerPhaseSchema,
});
export const runnerHeartbeatSchema = z.strictObject({
  instanceId: uuidSchema,
  phase: runnerPhaseSchema.optional(),
  gpuIds: gpuIdsSchema.optional(),
});
export const runnerLogsSchema = logBatchSchema.extend({ instanceId: uuidSchema });
export const runnerMetricsSchema = metricBatchSchema.extend({ instanceId: uuidSchema });
export const runnerOutputsSchema = z.strictObject({
  instanceId: uuidSchema,
  declarations: outputDeclarationsSchema,
});
export const runnerFinishSchema = z.strictObject({
  instanceId: uuidSchema,
  status: z.enum(['finished', 'failed', 'canceled']),
  exitCode: z.number().int().optional(),
  error: z.string().max(20000).optional(),
  endReason: z.literal('timed_out').optional(),
});

export type SiteSubmissionResultInput = z.infer<typeof submissionResultSchema>;
export type JobArrayCreateInput = z.infer<typeof jobArrayCreateSchema>;
export type RunnerStartInput = z.infer<typeof runnerStartSchema>;
export type RunnerHeartbeatInput = z.infer<typeof runnerHeartbeatSchema>;
export type RunnerFinishInput = z.infer<typeof runnerFinishSchema>;
