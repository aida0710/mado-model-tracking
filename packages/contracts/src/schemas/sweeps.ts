import { z } from 'zod';
import type {
  Sweep,
  SweepEarlyStopping,
  SweepMethod,
  SweepObjective,
  SweepPage,
  SweepParameterDefinition,
  SweepParameterValue,
  SweepStatus,
  SweepStatusReason,
  SweepTrial,
  SweepTrialCounts,
  SweepTrialPage,
  SweepTrialState,
} from '../sweeps.js';
import {
  cursorPageOf,
  idSchema,
  jobStatusSchema,
  runStatusSchema,
  timestampSchema,
} from './primitives.js';
import { namedContractSchema } from './schemaRegistry.js';
import type { Expect, MutuallyAssignable } from './typeAssertions.js';

export const sweepMethodSchema = z.enum(['grid', 'random', 'bayes']);
export const sweepParameterValueSchema = namedContractSchema(
  'SweepParameterValue',
  z.union([z.string(), z.number(), z.boolean()]),
);
// Not a discriminated union: the three forms are told apart by which key is present.
export const sweepParameterDefinitionSchema = namedContractSchema(
  'SweepParameterDefinition',
  z.union([
    z.strictObject({ values: z.array(sweepParameterValueSchema) }),
    z.strictObject({ value: sweepParameterValueSchema }),
    z.strictObject({
      distribution: z.enum(['uniform', 'log_uniform', 'int_uniform', 'q_uniform']),
      min: z.number(),
      max: z.number(),
      q: z.number().optional(),
    }),
  ]),
);
export const sweepObjectiveSchema = namedContractSchema(
  'SweepObjective',
  z.strictObject({
    metric: z.string(),
    goal: z.enum(['minimize', 'maximize']),
    aggregation: z.enum(['last', 'min', 'max']),
  }),
);
// minIter and eta are not restricted to integers by the API's sweep validation.
export const sweepEarlyStoppingSchema = namedContractSchema(
  'SweepEarlyStopping',
  z.strictObject({
    type: z.literal('hyperband'),
    minIter: z.number(),
    eta: z.number(),
    maxIter: z.number().optional(),
  }),
);
export const sweepStatusSchema = z.enum(['running', 'paused', 'finished', 'canceled', 'failed']);
export const sweepStatusReasonSchema = z.enum([
  'user_requested',
  'task_revision_changed',
  'owner_forbidden',
  'launch_failed',
  'max_trials_reached',
  'search_space_exhausted',
  'suggestion_failed',
]);
export const sweepTrialStateSchema = z.enum([
  'queued',
  'running',
  'finished',
  'failed',
  'canceled',
  'early_stopped',
]);
export const sweepTrialSchema = namedContractSchema(
  'SweepTrial',
  z.strictObject({
    id: idSchema,
    sweepId: idSchema,
    trialIndex: z.number().int(),
    parameters: z.record(z.string(), sweepParameterValueSchema),
    runId: idSchema,
    jobId: idSchema,
    state: sweepTrialStateSchema,
    objectiveValue: z.number().nullable(),
    objectiveStep: z.number().nullable(),
    stopReason: z.string().nullable(),
    runStatus: runStatusSchema,
    jobStatus: jobStatusSchema,
    jobCancelRequested: z.boolean(),
    createdAt: timestampSchema,
    endedAt: timestampSchema.nullable(),
  }),
);
// Spelled out per state so the published schema lists every count as a required property.
export const sweepTrialCountsSchema = namedContractSchema(
  'SweepTrialCounts',
  z.strictObject({
    queued: z.number().int(),
    running: z.number().int(),
    finished: z.number().int(),
    failed: z.number().int(),
    canceled: z.number().int(),
    early_stopped: z.number().int(),
    total: z.number().int(),
  }),
);
export const sweepSchema = namedContractSchema(
  'Sweep',
  z.strictObject({
    id: idSchema,
    projectId: idSchema,
    name: z.string(),
    taskId: idSchema,
    taskRevision: z.number().int(),
    experimentId: idSchema,
    method: sweepMethodSchema,
    searchSpace: z.record(z.string(), sweepParameterDefinitionSchema),
    objective: sweepObjectiveSchema,
    maxTrials: z.number().int(),
    parallelism: z.number().int(),
    earlyStopping: sweepEarlyStoppingSchema.nullable(),
    seed: z.number().int(),
    targetId: idSchema.nullable(),
    gpuIds: z.array(z.string()).nullable(),
    status: sweepStatusSchema,
    statusReason: sweepStatusReasonSchema.nullable(),
    createdBy: idSchema,
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    finishedAt: timestampSchema.nullable(),
    trialCounts: sweepTrialCountsSchema,
    bestTrial: sweepTrialSchema.nullable(),
  }),
);
export const sweepPageSchema = namedContractSchema('SweepPage', cursorPageOf(sweepSchema));
export const sweepTrialPageSchema = namedContractSchema(
  'SweepTrialPage',
  cursorPageOf(sweepTrialSchema),
);

type _SweepMethod = Expect<MutuallyAssignable<z.infer<typeof sweepMethodSchema>, SweepMethod>>;
type _SweepParameterValue = Expect<
  MutuallyAssignable<z.infer<typeof sweepParameterValueSchema>, SweepParameterValue>
>;
type _SweepParameterDefinition = Expect<
  MutuallyAssignable<z.infer<typeof sweepParameterDefinitionSchema>, SweepParameterDefinition>
>;
type _SweepObjective = Expect<
  MutuallyAssignable<z.infer<typeof sweepObjectiveSchema>, SweepObjective>
>;
type _SweepEarlyStopping = Expect<
  MutuallyAssignable<z.infer<typeof sweepEarlyStoppingSchema>, SweepEarlyStopping>
>;
type _SweepStatus = Expect<MutuallyAssignable<z.infer<typeof sweepStatusSchema>, SweepStatus>>;
type _SweepStatusReason = Expect<
  MutuallyAssignable<z.infer<typeof sweepStatusReasonSchema>, SweepStatusReason>
>;
type _SweepTrialState = Expect<
  MutuallyAssignable<z.infer<typeof sweepTrialStateSchema>, SweepTrialState>
>;
type _SweepTrial = Expect<MutuallyAssignable<z.infer<typeof sweepTrialSchema>, SweepTrial>>;
type _SweepTrialCounts = Expect<
  MutuallyAssignable<z.infer<typeof sweepTrialCountsSchema>, SweepTrialCounts>
>;
type _Sweep = Expect<MutuallyAssignable<z.infer<typeof sweepSchema>, Sweep>>;
type _SweepPage = Expect<MutuallyAssignable<z.infer<typeof sweepPageSchema>, SweepPage>>;
type _SweepTrialPage = Expect<
  MutuallyAssignable<z.infer<typeof sweepTrialPageSchema>, SweepTrialPage>
>;
