import { z } from 'zod';
import type { ArtifactMediaInfo } from '../artifactMediaInfo.js';
import { idSchema } from './primitives.js';
import { namedContractSchema } from './schemaRegistry.js';
import type { Expect, MutuallyAssignable } from './typeAssertions.js';

export const artifactMediaInfoSchema = namedContractSchema(
  'ArtifactMediaInfo',
  z.strictObject({
    artifactId: idSchema,
    durationSeconds: z.number(),
    sampleRate: z.number().int(),
    channels: z.number().int(),
    bitsPerSample: z.number().int().nullable(),
    codec: z.string(),
    source: z.enum(['header', 'ffprobe']),
  }),
);

type _ArtifactMediaInfo = Expect<
  MutuallyAssignable<z.infer<typeof artifactMediaInfoSchema>, ArtifactMediaInfo>
>;
