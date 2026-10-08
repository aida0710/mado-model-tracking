import { z } from 'zod';
import type {
  ModelAliasEvent,
  ModelAliasEventPage,
  ModelAliasEventSource,
} from '../modelAliases.js';
import { cursorPageOf, idSchema, timestampSchema } from './primitives.js';
import { namedContractSchema } from './schemaRegistry.js';
import type { Expect, MutuallyAssignable } from './typeAssertions.js';

export const modelAliasEventSourceSchema = z.enum([
  'web',
  'api',
  'mlflow',
  'promotion_policy',
  'version_deleted',
  'model_deleted',
]);
export const modelAliasEventSchema = namedContractSchema(
  'ModelAliasEvent',
  z.strictObject({
    id: idSchema,
    projectId: idSchema,
    modelId: idSchema,
    alias: z.string(),
    previousVersionId: idSchema.nullable(),
    previousVersion: z.string().nullable(),
    versionId: idSchema.nullable(),
    version: z.string().nullable(),
    source: modelAliasEventSourceSchema,
    reason: z.string(),
    promotionEvaluationId: idSchema.nullable(),
    actor: z
      .strictObject({ userId: idSchema, displayName: z.string(), tokenId: idSchema.nullable() })
      .nullable(),
    createdAt: timestampSchema,
  }),
);
export const modelAliasEventPageSchema = namedContractSchema(
  'ModelAliasEventPage',
  cursorPageOf(modelAliasEventSchema),
);

type _ModelAliasEventSource = Expect<
  MutuallyAssignable<z.infer<typeof modelAliasEventSourceSchema>, ModelAliasEventSource>
>;
type _ModelAliasEvent = Expect<
  MutuallyAssignable<z.infer<typeof modelAliasEventSchema>, ModelAliasEvent>
>;
type _ModelAliasEventPage = Expect<
  MutuallyAssignable<z.infer<typeof modelAliasEventPageSchema>, ModelAliasEventPage>
>;
