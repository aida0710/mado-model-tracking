import {
  MLFLOW_CHECKPOINT_PATH_PREFIX,
  type RunCheckpointFile,
  type RunKind,
} from '@mmt/contracts';
import { z } from 'zod';
import { DomainError } from './errors.js';
import { isSafeArtifactPath } from '../mlflow/artifacts/artifactPath.js';
import { jsonObjectSchema, uuidSchema } from './validation.js';

/** Only Runs that train weights save and continue from checkpoints. */
export const CHECKPOINT_RUN_KINDS: readonly RunKind[] = ['training', 'finetuning'];
// A checkpoint directory is model weights plus a few state files; this bounds the manifest row.
export const MAX_CHECKPOINT_FILES = 10000;
// metadata is a small description (epoch, loss, ...), not a place for training state.
const MAX_CHECKPOINT_METADATA_BYTES = 64 * 1024;
const MAX_FRAMEWORK_LENGTH = 100;

const checkpointFileSchema = z.strictObject({
  path: z.string().refine(isSafeArtifactPath, 'A safe relative path is required'),
  sha256: z.string().regex(/^[a-f0-9]{64}$/, 'A SHA256 digest is required'),
  size: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
});

const stepSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

export const runCheckpointCreateSchema = z.strictObject({
  step: stepSchema,
  artifactId: uuidSchema,
  manifest: z.strictObject({
    files: z
      .array(checkpointFileSchema)
      .min(1)
      .max(MAX_CHECKPOINT_FILES)
      .refine(hasUniquePaths, 'Checkpoint file paths must be unique'),
    includesOptimizer: z.boolean().default(false),
    framework: z.string().trim().min(1).max(MAX_FRAMEWORK_LENGTH).nullish(),
  }),
  metadata: jsonObjectSchema
    .refine(
      (metadata) => Buffer.byteLength(JSON.stringify(metadata)) <= MAX_CHECKPOINT_METADATA_BYTES,
      'Checkpoint metadata is too large',
    )
    .default({}),
});
export type RunCheckpointCreateInput = z.infer<typeof runCheckpointCreateSchema>;

export const runCheckpointListQuerySchema = z.strictObject({
  includeHidden: z.enum(['true', 'false']).default('false'),
});

export const jobRetryRequestSchema = z
  .strictObject({
    checkpointId: uuidSchema.optional(),
    resumeFromLatestCheckpoint: z.boolean().optional(),
  })
  .refine(
    (request) => !(request.checkpointId && request.resumeFromLatestCheckpoint),
    'Specify either checkpointId or resumeFromLatestCheckpoint',
  );
export type JobRetryInput = z.infer<typeof jobRetryRequestSchema>;

function hasUniquePaths(files: readonly RunCheckpointFile[]): boolean {
  return new Set(files.map((file) => file.path)).size === files.length;
}

/**
 * Splits an MLflow Run artifact path such as checkpoints/step-12/model/weights.pt into the step
 * and the path inside the checkpoint directory; null for every other path.
 */
export function parseMlflowCheckpointPath(
  path: string,
): { step: number; relativePath: string } | null {
  if (!path.startsWith(MLFLOW_CHECKPOINT_PATH_PREFIX)) return null;
  const match = /^(0|[1-9][0-9]*)\/(.+)$/.exec(path.slice(MLFLOW_CHECKPOINT_PATH_PREFIX.length));
  if (!match) return null;
  const step = Number(match[1]);
  if (!Number.isSafeInteger(step)) return null;
  return { step, relativePath: match[2]! };
}

export function assertCheckpointRunKind(kind: RunKind): void {
  if (!CHECKPOINT_RUN_KINDS.includes(kind))
    throw new DomainError(
      422,
      'checkpointはtrainingまたはfinetuningのRunにだけ登録できます',
      'checkpoint_run_kind',
    );
}

/**
 * A Run may continue from a checkpoint only when it trains the same kind of weights with code
 * from the same Code (any version of it): another kind or code reads the files differently.
 */
export function assertResumableFrom(
  checkpointRun: { kind: RunKind; codeId: string | null },
  run: { kind: RunKind; codeId: string | null },
): void {
  if (!CHECKPOINT_RUN_KINDS.includes(run.kind) || run.kind !== checkpointRun.kind)
    throw new DomainError(
      422,
      'checkpointは元のRunと同じ種類（trainingまたはfinetuning）のRunでだけ再開できます',
      'checkpoint_kind_mismatch',
    );
  if (!checkpointRun.codeId || checkpointRun.codeId !== run.codeId)
    throw new DomainError(
      422,
      'checkpointは元のRunと同じCodeのバージョンで再開してください',
      'checkpoint_code_mismatch',
    );
}
