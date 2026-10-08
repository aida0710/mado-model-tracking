import { z } from 'zod';
import type {
  RunResumeEvent,
  RunResumeEventPage,
  RunResumeResult,
  RunSegment,
} from '../runResume.js';
import { idSchema, runStatusSchema, timestampSchema } from './primitives.js';
import { runSchema } from './runs.js';
import { namedContractSchema } from './schemaRegistry.js';
import type { Expect, MutuallyAssignable } from './typeAssertions.js';

export const runResumeEventSchema = namedContractSchema(
  'RunResumeEvent',
  z.strictObject({
    id: idSchema,
    runId: idSchema,
    resumedAt: timestampSchema,
    previousStatus: z.enum(['finished', 'failed', 'canceled']),
    previousEndedAt: timestampSchema.nullable(),
    maxStepAtResume: z.number().nullable(),
    source: z.enum(['native', 'mlflow', 'sync']),
    actorUserId: idSchema.nullable(),
    reason: z.string().nullable(),
  }),
);
export const runResumeResultSchema = namedContractSchema(
  'RunResumeResult',
  z.strictObject({
    run: runSchema,
    resumed: z.boolean(),
    event: runResumeEventSchema.nullable(),
    lastSteps: z.record(z.string(), z.number()),
  }),
);
export const runSegmentSchema = namedContractSchema(
  'RunSegment',
  z.strictObject({
    startedAt: timestampSchema,
    endedAt: timestampSchema.nullable(),
    endStatus: runStatusSchema.nullable(),
    firstStep: z.number().nullable(),
  }),
);
export const runResumeEventPageSchema = namedContractSchema(
  'RunResumeEventPage',
  z.strictObject({
    items: z.array(runResumeEventSchema),
    segments: z.array(runSegmentSchema),
  }),
);

type _RunResumeEvent = Expect<
  MutuallyAssignable<z.infer<typeof runResumeEventSchema>, RunResumeEvent>
>;
type _RunResumeResult = Expect<
  MutuallyAssignable<z.infer<typeof runResumeResultSchema>, RunResumeResult>
>;
type _RunSegment = Expect<MutuallyAssignable<z.infer<typeof runSegmentSchema>, RunSegment>>;
type _RunResumeEventPage = Expect<
  MutuallyAssignable<z.infer<typeof runResumeEventPageSchema>, RunResumeEventPage>
>;
