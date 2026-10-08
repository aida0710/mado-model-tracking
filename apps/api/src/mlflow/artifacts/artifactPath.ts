import { DomainError } from '../../domain/errors.js';
import { uuidSchema } from '../../domain/validation.js';
import type { ArtifactLocation, ArtifactOwner } from './artifactTypes.js';

// Bound the composite PostgreSQL path index even when each character is multibyte.
const MAX_ARTIFACT_PATH_BYTES = 1024;
// Model IDs appear in URLs and in the native Artifact path prefix.
const MAX_MODEL_ID_LENGTH = 200;
export const ARTIFACT_TRANSFER_ROOT = '/api/2.0/mlflow-artifacts/artifacts';
const ownerCollections: Record<ArtifactOwner['kind'], string> = {
  run: 'runs',
  model: 'models',
  'model-version': 'model-versions',
};

function invalidPath(): never {
  throw new DomainError(422, 'Artifactには安全な相対パスが必要です', 'invalid_parameter_value');
}

export function validateArtifactPath(path: string, options: { directory?: boolean } = {}): string {
  const relativePath = options.directory && path.endsWith('/') ? path.slice(0, -1) : path;
  if (relativePath === '' && options.directory && path !== '/') return relativePath;
  if (!isSafeArtifactPath(relativePath)) invalidPath();
  return relativePath;
}

export function isSafeArtifactPath(path: string): boolean {
  return (
    !!path &&
    Buffer.byteLength(path, 'utf8') <= MAX_ARTIFACT_PATH_BYTES &&
    !path.startsWith('/') &&
    !/^[a-z]:/i.test(path) &&
    !/[\\\u0000-\u001f\u007f]/.test(path) &&
    !/%[a-f0-9]{2}/i.test(path) &&
    path.split('/').every((segment) => !!segment && segment !== '.' && segment !== '..')
  );
}

export function validateArtifactOwner(owner: ArtifactOwner): ArtifactOwner {
  if (owner.kind === 'run' || owner.kind === 'model-version') {
    if (!uuidSchema.safeParse(owner.id).success) invalidPath();
    return { ...owner, id: owner.id.toLowerCase() };
  }
  if (
    owner.kind !== 'model' ||
    owner.id.length > MAX_MODEL_ID_LENGTH ||
    !/^[a-z0-9][a-z0-9_-]*$/i.test(owner.id)
  )
    invalidPath();
  return owner;
}

export function parseArtifactLocation(
  path: string,
  options: { directory?: boolean } = {},
): ArtifactLocation {
  const [collection, ownerId, directory, ...segments] = path.split('/');
  const kind =
    collection === 'runs'
      ? 'run'
      : collection === 'models'
        ? 'model'
        : collection === 'model-versions'
          ? 'model-version'
          : null;
  if (!ownerId || directory !== 'artifacts' || !kind) invalidPath();
  const owner = validateArtifactOwner({ kind, id: ownerId });
  return { owner, path: validateArtifactPath(segments.join('/'), options) };
}

export function decodeArtifactLocation(encodedPath: string): ArtifactLocation {
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(encodedPath);
  } catch {
    invalidPath();
  }
  return parseArtifactLocation(decodedPath);
}

export function artifactRootUri(owner: ArtifactOwner): string {
  return `mlflow-artifacts:/${ownerCollections[owner.kind]}/${owner.id}/artifacts`;
}

export function nativeArtifactPath(location: ArtifactLocation): string {
  if (location.owner.kind === 'model-version')
    throw new DomainError(409, '登録モデル版のArtifactは変更できません', 'conflict');
  const path =
    location.owner.kind === 'run' ? location.path : `models/${location.owner.id}/${location.path}`;
  return validateArtifactPath(path);
}
