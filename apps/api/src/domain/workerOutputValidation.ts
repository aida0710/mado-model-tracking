import type { RunKind } from '@mmt/contracts';
import { z } from 'zod';
import { DomainError } from './errors.js';
import { isRelativeFilePath, jsonObjectSchema, uuidSchema } from './validation.js';

// Each model version starts every matching automation rule (inference and evaluation Jobs), so a
// container may not flood the queue; a training Run outputs a few checkpoints or variants.
export const MAX_MODEL_DECLARATIONS = 16;
// Dataset versions are reference rows, but each one is registered in the request's transaction;
// 64 covers per-split and per-language outputs while keeping that transaction short.
export const MAX_DATASET_DECLARATIONS = 64;
// Matches the worker's output path limit (python/src/mado_tracking/worker/container_outputs.py).
const MAX_OUTPUT_PATH_LENGTH = 1024;
// The worker saves /mmt/outputs/<path> as this Run Artifact path.
const CONTAINER_ARTIFACT_PREFIX = 'container/';
const OUTPUT_MODEL_RUN_KINDS: readonly RunKind[] = ['training', 'finetuning'];

const outputPathSchema = z
  .string()
  .max(MAX_OUTPUT_PATH_LENGTH)
  .refine(
    (path) => isRelativeFilePath(path) && !/[\r\n]/.test(path),
    'Output path must be a relative file path inside /mmt/outputs',
  );

const declarationIndexSchema = z
  .number()
  .int()
  .min(0)
  .max(MAX_MODEL_DECLARATIONS + MAX_DATASET_DECLARATIONS - 1);

const modelDeclarationSchema = z.strictObject({
  index: declarationIndexSchema,
  kind: z.literal('model'),
  path: outputPathSchema,
  modelId: uuidSchema.optional(),
  metadata: jsonObjectSchema.default({}),
});

const datasetDeclarationSchema = z
  .strictObject({
    index: declarationIndexSchema,
    kind: z.literal('dataset'),
    datasetId: uuidSchema,
    uri: z.string().min(1).max(4000).optional(),
    path: outputPathSchema.optional(),
    digest: z.string().min(1).max(1000),
    schema: jsonObjectSchema.default({}),
    metadata: jsonObjectSchema.default({}),
  })
  .refine(
    (declaration) => (declaration.uri === undefined) !== (declaration.path === undefined),
    'A dataset declaration needs exactly one of uri or path',
  );

// Shared by the worker (with its lease) and the site runner (with its instance ID).
export const outputDeclarationsSchema = z
  .array(z.union([modelDeclarationSchema, datasetDeclarationSchema]))
  .min(1)
  .max(MAX_MODEL_DECLARATIONS + MAX_DATASET_DECLARATIONS)
  .refine(
    (declarations) =>
      new Set(declarations.map((declaration) => declaration.index)).size === declarations.length,
    'Declaration indexes must be unique',
  );

export const workerOutputsSchema = z.strictObject({
  leaseId: uuidSchema,
  declarations: outputDeclarationsSchema,
});

export type WorkerOutputsInput = z.infer<typeof workerOutputsSchema>;
export type ParsedOutputDeclaration = WorkerOutputsInput['declarations'][number];
export type ModelOutputDeclaration = Extract<ParsedOutputDeclaration, { kind: 'model' }>;
export type DatasetOutputDeclaration = Extract<ParsedOutputDeclaration, { kind: 'dataset' }>;
export type DeclarationCounts = Record<ParsedOutputDeclaration['kind'], number>;

export function containerArtifactPath(outputPath: string): string {
  return `${CONTAINER_ARTIFACT_PREFIX}${outputPath}`;
}

export function countDeclarations(
  declarations: readonly Pick<ParsedOutputDeclaration, 'kind'>[],
): DeclarationCounts {
  const counts: DeclarationCounts = { model: 0, dataset: 0 };
  for (const declaration of declarations) counts[declaration.kind] += 1;
  return counts;
}

export function assertModelOutputsAllowed(run: { kind: RunKind }, counts: DeclarationCounts): void {
  if (counts.model > 0 && !OUTPUT_MODEL_RUN_KINDS.includes(run.kind))
    throw new DomainError(
      422,
      '出力モデルを宣言できるのはtrainingまたはfinetuningのRunだけです',
      'output_model_kind',
    );
}

// Limits apply to the Run as a whole, so a worker cannot exceed them by splitting requests.
export function assertDeclarationLimits(counts: DeclarationCounts): void {
  if (counts.model > MAX_MODEL_DECLARATIONS || counts.dataset > MAX_DATASET_DECLARATIONS)
    throw new DomainError(
      422,
      `出力の宣言はRunごとにモデル${MAX_MODEL_DECLARATIONS}件・データセット${MAX_DATASET_DECLARATIONS}件までです`,
      'output_declaration_limit',
    );
}

/**
 * The Task's output model wins: a declaration naming another Model is rejected because a reader
 * could not tell which Model holds the Run's output. Without a Task setting the container must
 * name the Model itself.
 */
export function chooseOutputModelId(choice: {
  declaredModelId: string | undefined;
  taskModelId: string | null;
}): string {
  const { declaredModelId, taskModelId } = choice;
  if (taskModelId) {
    if (declaredModelId && declaredModelId !== taskModelId)
      throw new DomainError(
        422,
        'Taskの出力モデルと別のModelは宣言できません',
        'output_model_conflict',
      );
    return taskModelId;
  }
  if (!declaredModelId)
    throw new DomainError(
      422,
      'Taskに出力モデルの設定が無いRunでは宣言にmodelIdが必要です',
      'output_model_required',
    );
  return declaredModelId;
}
