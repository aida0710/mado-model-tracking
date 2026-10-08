import { z } from 'zod';
import type {
  ExperimentTask,
  RepositoryFiles,
  RunOutputRegistration,
  TaskExecution,
  TaskRunPage,
} from '../experimentTasks.js';
import {
  cursorPageOf,
  idSchema,
  jsonObjectSchema,
  runKindSchema,
  stringMapSchema,
  timestampSchema,
} from './primitives.js';
import { jobSchema } from './execution.js';
import { runSchema, taskOutputModelSchema } from './runs.js';
import { namedContractSchema } from './schemaRegistry.js';
import type { Expect, MutuallyAssignable } from './typeAssertions.js';

export const experimentTaskSchema = namedContractSchema(
  'ExperimentTask',
  z.strictObject({
    id: idSchema,
    projectId: idSchema,
    experimentId: idSchema,
    name: z.string(),
    description: z.string(),
    kind: runKindSchema,
    codeVersionId: idSchema,
    modelVersionId: idSchema.nullable(),
    inputDatasetVersionIds: z.array(idSchema),
    parameters: jsonObjectSchema,
    tags: stringMapSchema,
    targetId: idSchema.nullable(),
    gpuIds: z.array(z.string()),
    outputModel: taskOutputModelSchema.nullable().optional(),
    revision: z.number().int(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  }),
);
export const runOutputRegistrationSchema = namedContractSchema(
  'RunOutputRegistration',
  z.strictObject({
    status: z.enum(['registered', 'failed', 'skipped']),
    modelVersionId: idSchema.nullable(),
    error: z.string().nullable(),
    reason: z.literal('already_registered_by_run').nullable(),
  }),
);
export const taskExecutionSchema = namedContractSchema(
  'TaskExecution',
  z.strictObject({ run: runSchema, job: jobSchema }),
);
export const taskRunPageSchema = namedContractSchema('TaskRunPage', cursorPageOf(runSchema));
export const repositoryFilesSchema = namedContractSchema(
  'RepositoryFiles',
  z.strictObject({
    commit: z.string(),
    files: stringMapSchema,
    omittedPaths: z.array(z.string()),
  }),
);

type _ExperimentTask = Expect<
  MutuallyAssignable<z.infer<typeof experimentTaskSchema>, ExperimentTask>
>;
type _RunOutputRegistration = Expect<
  MutuallyAssignable<z.infer<typeof runOutputRegistrationSchema>, RunOutputRegistration>
>;
type _TaskExecution = Expect<
  MutuallyAssignable<z.infer<typeof taskExecutionSchema>, TaskExecution>
>;
type _TaskRunPage = Expect<MutuallyAssignable<z.infer<typeof taskRunPageSchema>, TaskRunPage>>;
type _RepositoryFiles = Expect<
  MutuallyAssignable<z.infer<typeof repositoryFilesSchema>, RepositoryFiles>
>;
