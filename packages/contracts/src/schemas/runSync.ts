import { z } from 'zod';
import type { ArtifactPresence, SyncBatchCounts, SyncBatchResult } from '../runSync.js';
import { namedContractSchema } from './schemaRegistry.js';
import type { Expect, MutuallyAssignable } from './typeAssertions.js';

export const syncBatchCountsSchema = namedContractSchema(
  'SyncBatchCounts',
  z.strictObject({
    metrics: z.number().int(),
    params: z.number().int(),
    tags: z.number().int(),
    logs: z.number().int(),
  }),
);
export const syncBatchResultSchema = namedContractSchema(
  'SyncBatchResult',
  z.strictObject({
    applied: z.boolean(),
    duplicate: z.boolean(),
    counts: syncBatchCountsSchema,
  }),
);
export const artifactPresenceSchema = namedContractSchema(
  'ArtifactPresence',
  z.strictObject({ present: z.array(z.string()) }),
);

type _SyncBatchCounts = Expect<
  MutuallyAssignable<z.infer<typeof syncBatchCountsSchema>, SyncBatchCounts>
>;
type _SyncBatchResult = Expect<
  MutuallyAssignable<z.infer<typeof syncBatchResultSchema>, SyncBatchResult>
>;
type _ArtifactPresence = Expect<
  MutuallyAssignable<z.infer<typeof artifactPresenceSchema>, ArtifactPresence>
>;
