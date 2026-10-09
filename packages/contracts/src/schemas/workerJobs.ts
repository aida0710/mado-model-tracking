import { z } from 'zod';
import type { WorkerJob } from '../index.js';
import { workerResumeCheckpointSchema } from './checkpoints.js';
import { computeTargetSchema, jobSchema } from './execution.js';
import { codeVersionSchema, datasetVersionSchema, modelVersionSchema } from './registry.js';
import { jsonObjectSchema } from './primitives.js';
import { runSchema } from './runs.js';
import { namedContractSchema } from './schemaRegistry.js';
import type { Expect, MutuallyAssignable } from './typeAssertions.js';

export const workerJobSchema = namedContractSchema(
  'WorkerJob',
  z.strictObject({
    job: jobSchema,
    run: runSchema,
    target: computeTargetSchema,
    codeVersion: codeVersionSchema,
    modelVersion: modelVersionSchema.nullable(),
    inputDatasets: z.array(datasetVersionSchema),
    jobToken: z.string().nullable(),
    resumeCheckpoint: workerResumeCheckpointSchema.nullable().optional(),
    inputCheckpoint: workerResumeCheckpointSchema.nullable().optional(),
    triggerPayload: jsonObjectSchema.nullable().optional(),
  }),
);

type _WorkerJob = Expect<MutuallyAssignable<z.infer<typeof workerJobSchema>, WorkerJob>>;
