import { z } from 'zod';
import type { DatasetVersionFile, DatasetVersionFilePage } from '../datasetContent.js';
import { idSchema } from './primitives.js';
import { namedContractSchema } from './schemaRegistry.js';
import type { Expect, MutuallyAssignable } from './typeAssertions.js';

export const datasetVersionFileSchema = namedContractSchema(
  'DatasetVersionFile',
  z.strictObject({
    path: z.string(),
    artifactId: idSchema,
    size: z.number().int(),
    sha256: z.string(),
    mimeType: z.string(),
  }),
);
export const datasetVersionFilePageSchema = namedContractSchema(
  'DatasetVersionFilePage',
  z.strictObject({ items: z.array(datasetVersionFileSchema), nextCursor: z.string().optional() }),
);

type _DatasetVersionFile = Expect<
  MutuallyAssignable<z.infer<typeof datasetVersionFileSchema>, DatasetVersionFile>
>;
type _DatasetVersionFilePage = Expect<
  MutuallyAssignable<z.infer<typeof datasetVersionFilePageSchema>, DatasetVersionFilePage>
>;
