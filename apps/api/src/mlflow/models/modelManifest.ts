import type { JsonObject } from '@mmt/contracts';
import { conflict } from '../../domain/errors.js';
import { invalidParameter } from './validation.js';
import type { ArtifactManifestEntry, SavedModelArtifacts } from './types.js';

// MLmodel fields used by the installed sklearn, pyfunc, PyTorch, TensorFlow and transformers flavors.
const MODEL_BODY_PATH_FIELDS = [
  'pickled_model',
  'python_model',
  'model_data',
  'model_file',
  'model_code_path',
  'model_path',
  'data',
  'saved_model_dir',
  'model_binary',
  'local_base_model_path',
];
// Default filenames are used only when the captured MLmodel has no body path fields.
const DEFAULT_WEIGHT_PATHS = [
  'model.pkl',
  'python_model.pkl',
  'data/model.pth',
  'model.pth',
  'model.pt',
  'model.onnx',
];

function modelFlavors(metadata: JsonObject): JsonObject[] {
  const mlmodel = metadata.mlmodel;
  if (!mlmodel || typeof mlmodel !== 'object' || Array.isArray(mlmodel)) return [];
  const flavors = mlmodel.flavors;
  if (!flavors || typeof flavors !== 'object' || Array.isArray(flavors)) return [];
  return Object.values(flavors).filter(
    (flavor): flavor is JsonObject =>
      !!flavor && typeof flavor === 'object' && !Array.isArray(flavor),
  );
}

function modelBodyPaths(metadata: JsonObject): string[] {
  return modelFlavors(metadata).flatMap((flavor) =>
    MODEL_BODY_PATH_FIELDS.flatMap((key) =>
      typeof flavor[key] === 'string' ? [artifactPath(flavor[key].replace(/\/$/, ''))] : [],
    ),
  );
}

export function artifactPath(path: string): string {
  if (
    !path ||
    path.startsWith('/') ||
    path.includes('\\') ||
    /[\x00-\x1f\x7f]/.test(path) ||
    path.split('/').some((part) => !part || part === '.' || part === '..')
  )
    invalidParameter('weightsのArtifact相対pathが不正です');
  return path;
}

export function validateFlavorArtifacts(
  manifest: ArtifactManifestEntry[],
  metadata: JsonObject,
): void {
  const referencedPaths: string[] = modelBodyPaths(metadata);
  for (const flavor of modelFlavors(metadata)) {
    if (typeof flavor.code === 'string') referencedPaths.push(flavor.code);
    const environment = flavor.env;
    if (typeof environment === 'string') referencedPaths.push(environment);
    else if (environment && typeof environment === 'object' && !Array.isArray(environment)) {
      for (const path of Object.values(environment))
        if (typeof path === 'string') referencedPaths.push(path);
    }
  }
  for (const path of referencedPaths) {
    const relativePath = artifactPath(path.replace(/\/$/, ''));
    if (
      !manifest.some(
        (entry) => entry.path === relativePath || entry.path.startsWith(`${relativePath}/`),
      )
    )
      conflict('MLmodelが参照するモデル本体・環境・コードのArtifactが未保存です');
  }
}

export function validateModelManifest(manifest: ArtifactManifestEntry[]): void {
  if (!manifest.some((entry) => entry.path === 'MLmodel'))
    conflict('MLmodel Artifactが保存されていません');
  if (manifest.length < 2) conflict('モデル本体のArtifactが保存されていません');
  for (const entry of manifest) artifactPath(entry.path);
}

function weightCandidates(saved: SavedModelArtifacts): ArtifactManifestEntry[] {
  const bodyPaths = modelBodyPaths(saved.metadata);
  const knownPaths = new Set(bodyPaths.length ? bodyPaths : DEFAULT_WEIGHT_PATHS);
  return saved.manifest.filter((entry) => knownPaths.has(entry.path));
}

export function validateReadyModel(saved: SavedModelArtifacts): void {
  validateModelManifest(saved.manifest);
  validateFlavorArtifacts(saved.manifest, saved.metadata);
  if (saved.tags['mmt.weights_path'] !== undefined) {
    selectWeightsArtifact(saved, saved.tags);
    return;
  }
  const hasModelBody = modelBodyPaths(saved.metadata).some((path) =>
    saved.manifest.some((entry) => entry.path === path || entry.path.startsWith(`${path}/`)),
  );
  if (!hasModelBody && !weightCandidates(saved).length)
    conflict('保存済みモデル本体のArtifactが必要です');
}

export function selectWeightsArtifact(
  saved: SavedModelArtifacts,
  tags: Record<string, string>,
): ArtifactManifestEntry {
  const requestedPath = tags['mmt.weights_path'];
  if (requestedPath !== undefined) {
    const artifact = saved.manifest.find((entry) => entry.path === artifactPath(requestedPath));
    if (!artifact || artifact.path === 'MLmodel')
      conflict('mmt.weights_pathのモデル本体Artifactが保存されていません');
    return artifact;
  }
  const candidates = weightCandidates(saved);
  if (candidates.length !== 1)
    invalidParameter(
      'モデル本体を一意に選べません。mmt.weights_pathで保存済みArtifactを指定してください',
    );
  return candidates[0]!;
}

export function selectPrimaryModelArtifact(
  saved: SavedModelArtifacts,
  tags: Record<string, string>,
): { artifact: ArtifactManifestEntry; modelFormat: 'weights' | 'mlflow' } {
  const candidates = weightCandidates(saved);
  const hasModelDirectory = modelBodyPaths(saved.metadata).some((path) =>
    saved.manifest.some((entry) => entry.path.startsWith(`${path}/`)),
  );
  if (tags['mmt.weights_path'] !== undefined || candidates.length || !hasModelDirectory)
    return { artifact: selectWeightsArtifact(saved, tags), modelFormat: 'weights' };
  const descriptor = saved.manifest.find((entry) => entry.path === 'MLmodel');
  if (!descriptor) conflict('MLmodel Artifactが保存されていません');
  return { artifact: descriptor, modelFormat: 'mlflow' };
}
