import { z } from 'zod';
import {
  executionModeSchema,
  gpuIdsSchema,
  jsonObjectSchema,
  nameSchema,
  runKindSchema,
  tagsSchema,
  uniqueIdsSchema,
  uuidSchema,
} from './validation.js';

// PostgreSQL stores task revisions as integer; never round a revision supplied by clients.
export const MAX_TASK_REVISION = 2_147_483_647;
const revisionSchema = z.number().int().min(1).max(MAX_TASK_REVISION);
// Bound polling and history navigation while allowing larger requested pages.
export const DEFAULT_TASK_HISTORY_LIMIT = 50;
export const MAX_TASK_HISTORY_LIMIT = 200;
const taskFields = {
  name: nameSchema,
  description: z.string().max(20000),
  kind: runKindSchema,
  codeVersionId: uuidSchema,
  modelVersionId: uuidSchema.nullable(),
  inputDatasetVersionIds: uniqueIdsSchema,
  parameters: jsonObjectSchema,
  tags: tagsSchema,
  targetId: uuidSchema.nullable(),
  gpuIds: gpuIdsSchema,
};

export const taskCreateSchema = z.strictObject({
  ...taskFields,
  experimentId: uuidSchema,
  description: taskFields.description.default(''),
  modelVersionId: taskFields.modelVersionId.default(null),
  inputDatasetVersionIds: taskFields.inputDatasetVersionIds.default([]),
  parameters: taskFields.parameters.default({}),
  tags: taskFields.tags.default({}),
  targetId: taskFields.targetId.default(null),
  gpuIds: taskFields.gpuIds.default([]),
});
export const taskPatchSchema = z.strictObject(taskFields).partial().extend({
  expectedRevision: revisionSchema,
});
export const taskLaunchSchema = z.strictObject({
  expectedRevision: revisionSchema,
  executionMode: executionModeSchema.default('run'),
  targetId: uuidSchema.optional(),
  gpuIds: gpuIdsSchema.optional(),
  name: nameSchema.optional(),
  parameters: jsonObjectSchema.optional(),
  modelVersionId: uuidSchema.nullable().optional(),
  inputDatasetVersionIds: uniqueIdsSchema.optional(),
});
export const taskHistoryQuerySchema = z.strictObject({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_TASK_HISTORY_LIMIT)
    .default(DEFAULT_TASK_HISTORY_LIMIT),
  cursor: uuidSchema.optional(),
});

export type TaskCreate = z.infer<typeof taskCreateSchema>;
export type TaskPatch = z.infer<typeof taskPatchSchema>;
export type TaskLaunch = z.infer<typeof taskLaunchSchema>;
export type TaskHistoryQuery = z.infer<typeof taskHistoryQuerySchema>;
