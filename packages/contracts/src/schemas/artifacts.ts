import { z } from 'zod';
import type { Artifact } from '../index.js';
import type { ArtifactDirectoryEntry, ArtifactPage, ArtifactTree } from '../artifactListing.js';
import type { ArtifactBackendUsage, ArtifactUsage } from '../artifactUsage.js';
import { idSchema, timestampSchema } from './primitives.js';
import { namedContractSchema } from './schemaRegistry.js';
import type { Expect, MutuallyAssignable } from './typeAssertions.js';

export const artifactSchema = namedContractSchema(
  'Artifact',
  z.strictObject({
    id: idSchema,
    projectId: idSchema,
    runId: idSchema.nullable(),
    path: z.string(),
    backend: z.string(),
    storageKey: z.string(),
    mimeType: z.string(),
    size: z.number().int(),
    sha256: z.string(),
    createdAt: timestampSchema,
    deletedAt: timestampSchema.nullable().optional(),
  }),
);
export const artifactPageSchema = namedContractSchema(
  'ArtifactPage',
  z.strictObject({ items: z.array(artifactSchema), nextCursor: z.string().optional() }),
);
export const artifactDirectoryEntrySchema = namedContractSchema(
  'ArtifactDirectoryEntry',
  z.strictObject({ prefix: z.string(), fileCount: z.number().int(), totalSize: z.number().int() }),
);
export const artifactTreeSchema = namedContractSchema(
  'ArtifactTree',
  z.strictObject({
    prefix: z.string(),
    directories: z.array(artifactDirectoryEntrySchema),
    directoriesTruncated: z.boolean(),
    fileCount: z.number().int(),
    totalSize: z.number().int(),
  }),
);
export const artifactBackendUsageSchema = namedContractSchema(
  'ArtifactBackendUsage',
  z.strictObject({
    backend: z.string(),
    artifactCount: z.number().int(),
    totalBytes: z.number().int(),
    pendingDeletionCount: z.number().int(),
    pendingDeletionBytes: z.number().int(),
    unreferencedOldVersionCount: z.number().int(),
    unreferencedOldVersionBytes: z.number().int(),
  }),
);
export const artifactUsageSchema = namedContractSchema(
  'ArtifactUsage',
  z.strictObject({
    backends: z.array(artifactBackendUsageSchema),
    deleteGraceDays: z.number().int(),
  }),
);

type _Artifact = Expect<MutuallyAssignable<z.infer<typeof artifactSchema>, Artifact>>;
type _ArtifactPage = Expect<MutuallyAssignable<z.infer<typeof artifactPageSchema>, ArtifactPage>>;
type _ArtifactDirectoryEntry = Expect<
  MutuallyAssignable<z.infer<typeof artifactDirectoryEntrySchema>, ArtifactDirectoryEntry>
>;
type _ArtifactTree = Expect<MutuallyAssignable<z.infer<typeof artifactTreeSchema>, ArtifactTree>>;
type _ArtifactBackendUsage = Expect<
  MutuallyAssignable<z.infer<typeof artifactBackendUsageSchema>, ArtifactBackendUsage>
>;
type _ArtifactUsage = Expect<MutuallyAssignable<z.infer<typeof artifactUsageSchema>, ArtifactUsage>>;
