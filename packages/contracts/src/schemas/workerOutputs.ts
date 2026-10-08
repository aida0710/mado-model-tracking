import { z } from 'zod';
import type { RunOutputDeclaration, WorkerOutputsResponse } from '../workerOutputs.js';
import { idSchema, timestampSchema } from './primitives.js';
import { namedContractSchema } from './schemaRegistry.js';
import type { Expect, MutuallyAssignable } from './typeAssertions.js';

export const runOutputDeclarationSchema = namedContractSchema(
  'RunOutputDeclaration',
  z.strictObject({
    index: z.number().int(),
    kind: z.enum(['model', 'dataset']),
    modelVersionId: idSchema.nullable(),
    datasetVersionId: idSchema.nullable(),
    createdAt: timestampSchema,
  }),
);
export const workerOutputsResponseSchema = namedContractSchema(
  'WorkerOutputsResponse',
  z.strictObject({ items: z.array(runOutputDeclarationSchema) }),
);

type _RunOutputDeclaration = Expect<
  MutuallyAssignable<z.infer<typeof runOutputDeclarationSchema>, RunOutputDeclaration>
>;
type _WorkerOutputsResponse = Expect<
  MutuallyAssignable<z.infer<typeof workerOutputsResponseSchema>, WorkerOutputsResponse>
>;
