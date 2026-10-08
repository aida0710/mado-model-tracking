import { z } from 'zod';
import { uuidSchema } from './validation.js';

// Matches the model_alias_events.reason CHECK so the API rejects before the database does.
export const MAX_MODEL_ALIAS_REASON_LENGTH = 2000;
const DEFAULT_MODEL_ALIAS_EVENT_LIMIT = 50;
// Bounds one page of history; the Web table and SDK page through longer histories.
const MAX_MODEL_ALIAS_EVENT_LIMIT = 200;

const reasonSchema = z.string().max(MAX_MODEL_ALIAS_REASON_LENGTH);

export const modelAliasAssignmentSchema = z.strictObject({
  versionId: uuidSchema,
  reason: reasonSchema.optional(),
});

export const modelAliasRemovalSchema = z.strictObject({
  reason: reasonSchema.optional(),
});

export const modelAliasEventQuerySchema = z.strictObject({
  alias: z.string().min(1).max(200).optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_MODEL_ALIAS_EVENT_LIMIT)
    .default(DEFAULT_MODEL_ALIAS_EVENT_LIMIT),
  cursor: uuidSchema.optional(),
});

export type ModelAliasAssignment = z.infer<typeof modelAliasAssignmentSchema>;
export type ModelAliasEventQuery = z.infer<typeof modelAliasEventQuerySchema>;
