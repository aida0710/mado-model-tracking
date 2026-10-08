import { z } from 'zod';
import type {
  RunCheckpoint,
  RunCheckpointArtifact,
  RunCheckpointFile,
  RunCheckpointManifest,
  RunCheckpointPage,
  RunCheckpointSource,
  WorkerResumeCheckpoint,
} from '../checkpoints.js';
import { idSchema, itemsOf, jsonObjectSchema, timestampSchema } from './primitives.js';
import { namedContractSchema } from './schemaRegistry.js';
import type { Expect, MutuallyAssignable } from './typeAssertions.js';

export const runCheckpointSourceSchema = z.enum(['native', 'mlflow']);
export const runCheckpointFileSchema = namedContractSchema(
  'RunCheckpointFile',
  z.strictObject({ path: z.string(), sha256: z.string(), size: z.number().int() }),
);
export const runCheckpointManifestSchema = namedContractSchema(
  'RunCheckpointManifest',
  z.strictObject({
    files: z.array(runCheckpointFileSchema),
    includesOptimizer: z.boolean(),
    framework: z.string().nullable(),
  }),
);
export const runCheckpointArtifactSchema = namedContractSchema(
  'RunCheckpointArtifact',
  z.strictObject({
    id: idSchema,
    path: z.string(),
    size: z.number().int(),
    sha256: z.string(),
  }),
);
export const runCheckpointSchema = namedContractSchema(
  'RunCheckpoint',
  z.strictObject({
    id: idSchema,
    projectId: idSchema,
    runId: idSchema,
    step: z.number().int(),
    source: runCheckpointSourceSchema,
    artifactIds: z.array(idSchema),
    artifacts: z.array(runCheckpointArtifactSchema),
    manifest: runCheckpointManifestSchema,
    metadata: jsonObjectSchema,
    retained: z.boolean(),
    totalSize: z.number().int(),
    createdAt: timestampSchema,
  }),
);
export const runCheckpointPageSchema = namedContractSchema(
  'RunCheckpointPage',
  itemsOf(runCheckpointSchema),
);
export const workerResumeCheckpointSchema = namedContractSchema(
  'WorkerResumeCheckpoint',
  z.strictObject({
    id: idSchema,
    runId: idSchema,
    step: z.number().int(),
    source: runCheckpointSourceSchema,
    artifacts: z.array(runCheckpointArtifactSchema),
    manifest: runCheckpointManifestSchema,
    metadata: jsonObjectSchema,
  }),
);

type _RunCheckpointSource = Expect<
  MutuallyAssignable<z.infer<typeof runCheckpointSourceSchema>, RunCheckpointSource>
>;
type _RunCheckpointFile = Expect<
  MutuallyAssignable<z.infer<typeof runCheckpointFileSchema>, RunCheckpointFile>
>;
type _RunCheckpointManifest = Expect<
  MutuallyAssignable<z.infer<typeof runCheckpointManifestSchema>, RunCheckpointManifest>
>;
type _RunCheckpointArtifact = Expect<
  MutuallyAssignable<z.infer<typeof runCheckpointArtifactSchema>, RunCheckpointArtifact>
>;
type _RunCheckpoint = Expect<
  MutuallyAssignable<z.infer<typeof runCheckpointSchema>, RunCheckpoint>
>;
type _RunCheckpointPage = Expect<
  MutuallyAssignable<z.infer<typeof runCheckpointPageSchema>, RunCheckpointPage>
>;
type _WorkerResumeCheckpoint = Expect<
  MutuallyAssignable<z.infer<typeof workerResumeCheckpointSchema>, WorkerResumeCheckpoint>
>;
