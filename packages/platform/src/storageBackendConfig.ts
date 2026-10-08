import path from 'node:path';
import { MULTIPART_MIN_PART_BYTES } from './artifactMultipart.js';

export type StorageBackendKind = 'filesystem' | 's3';
export type S3SignatureVersion = 'v4' | 'v2';
export type S3ChecksumMode = 'when_required' | 'when_supported';

export interface FilesystemBackendConfig {
  kind: 'filesystem';
  rootPath: string;
}
export interface S3BackendConfig {
  kind: 's3';
  /** Absent means the AWS endpoint for the region. */
  endpoint?: string;
  region: string;
  bucket: string;
  /** Normalized without leading or trailing slashes; empty means the bucket root. */
  prefix: string;
  pathStyle: boolean;
  signatureVersion: S3SignatureVersion;
  tlsVerify: boolean;
  checksumMode: S3ChecksumMode;
  multipartPartSizeBytes: number;
  /**
   * false stores every Artifact with one PutObject, for S3-compatible services whose multipart
   * API does not work. Backends saved before this setting existed lack it, which means true.
   */
  multipartEnabled?: boolean;
}
export type StorageBackendConfig = FilesystemBackendConfig | S3BackendConfig;

/** Everything optional so callers can pass request bodies; normalization fills the defaults. */
export interface StorageBackendConfigInput {
  kind: StorageBackendKind;
  rootPath?: string;
  endpoint?: string | null;
  region?: string;
  bucket?: string;
  prefix?: string;
  pathStyle?: boolean;
  signatureVersion?: S3SignatureVersion;
  tlsVerify?: boolean;
  checksumMode?: S3ChecksumMode;
  multipartPartSizeBytes?: number;
  multipartEnabled?: boolean;
}

// Two parts of this size are buffered per streamed upload, so the default bounds memory at 16 MiB.
export const DEFAULT_MULTIPART_PART_SIZE_BYTES = 8 * 1024 * 1024;
// put() keeps two parts in memory at once; 512 MiB parts already cost 1 GiB per upload.
export const MAX_MULTIPART_PART_SIZE_BYTES = 512 * 1024 * 1024;
// The AWS SDK needs some region for signing even when an S3-compatible endpoint ignores it.
export const DEFAULT_S3_REGION = 'us-east-1';
// AWS rejects object key prefixes above 1024 bytes; artifact keys need room below the prefix.
const MAX_S3_PREFIX_LENGTH = 512;
// Backend names are stored in artifacts.backend and projects.artifact_backend, so they stay short.
const STORAGE_BACKEND_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
// S3 bucket naming rules: 3-63 characters of lowercase letters, digits, dots and hyphens.
const S3_BUCKET_NAME_PATTERN = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const S3_REGION_PATTERN = /^[a-z0-9-]{1,64}$/;
const S3_PREFIX_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export type StorageBackendConfigErrorCode =
  | 'invalid_storage_backend_name'
  | 'invalid_storage_backend_config';

export class StorageBackendConfigError extends Error {
  constructor(
    readonly code: StorageBackendConfigErrorCode,
    /** Name of the offending field, safe to show: values are never part of the message. */
    readonly field: string,
  ) {
    super(`Invalid storage backend setting: ${field}`);
    this.name = 'StorageBackendConfigError';
  }
}

export function isValidStorageBackendName(name: string): boolean {
  return STORAGE_BACKEND_NAME_PATTERN.test(name);
}

function invalid(field: string): never {
  throw new StorageBackendConfigError('invalid_storage_backend_config', field);
}

function normalizeRootPath(rootPath: string | undefined): string {
  if (!rootPath || !path.isAbsolute(rootPath) || /[\x00-\x1f\x7f]/.test(rootPath))
    invalid('rootPath');
  // A path with .. segments would hide where Artifacts really land.
  if (rootPath.split(/[\\/]/).includes('..')) invalid('rootPath');
  return path.normalize(rootPath);
}

function normalizeEndpoint(endpoint: string | null | undefined): string | undefined {
  if (!endpoint) return undefined;
  if (!URL.canParse(endpoint)) invalid('endpoint');
  const url = new URL(endpoint);
  if (!['http:', 'https:'].includes(url.protocol)) invalid('endpoint');
  // Credentials belong in the encrypted secret, never in a URL that is shown to administrators.
  if (url.username || url.password || url.search || url.hash) invalid('endpoint');
  return url.toString().replace(/\/$/, '');
}

/** Accepts "a/b", "/a/b/" or "" and returns "a/b"; segments follow the artifact key rules. */
export function normalizeS3Prefix(prefix: string | undefined): string {
  const segments = (prefix ?? '').split('/').filter(Boolean);
  if (!segments.every((segment) => S3_PREFIX_SEGMENT_PATTERN.test(segment))) invalid('prefix');
  const normalized = segments.join('/');
  if (normalized.length > MAX_S3_PREFIX_LENGTH) invalid('prefix');
  return normalized;
}

function normalizePartSize(size: number | undefined): number {
  const partSize = size ?? DEFAULT_MULTIPART_PART_SIZE_BYTES;
  if (
    !Number.isSafeInteger(partSize) ||
    partSize < MULTIPART_MIN_PART_BYTES ||
    partSize > MAX_MULTIPART_PART_SIZE_BYTES
  )
    invalid('multipartPartSizeBytes');
  return partSize;
}

/**
 * Signature v2 signs no payload checksum, and the SDK's WHEN_SUPPORTED checksums arrive as
 * aws-chunked trailers that v2-only services cannot parse, so v2 accepts only WHEN_REQUIRED.
 * The region is still kept for v2: the SDK resolves the AWS endpoint from it, the signature
 * does not use it.
 */
function normalizeChecksumMode(
  checksumMode: S3ChecksumMode | undefined,
  signatureVersion: S3SignatureVersion,
): S3ChecksumMode {
  const mode = checksumMode ?? 'when_required';
  if (!['when_required', 'when_supported'].includes(mode)) invalid('checksumMode');
  if (signatureVersion === 'v2' && mode !== 'when_required') invalid('checksumMode');
  return mode;
}

/** Validates an administrator's backend settings and fills defaults. */
export function normalizeStorageBackendConfig(
  input: StorageBackendConfigInput,
): StorageBackendConfig {
  if (input.kind === 'filesystem')
    return { kind: 'filesystem', rootPath: normalizeRootPath(input.rootPath) };
  if (input.kind !== 's3') invalid('kind');
  const signatureVersion = input.signatureVersion ?? 'v4';
  if (!['v4', 'v2'].includes(signatureVersion)) invalid('signatureVersion');
  if (!input.bucket || !S3_BUCKET_NAME_PATTERN.test(input.bucket)) invalid('bucket');
  const region = input.region || DEFAULT_S3_REGION;
  if (!S3_REGION_PATTERN.test(region)) invalid('region');
  const checksumMode = normalizeChecksumMode(input.checksumMode, signatureVersion);
  if (input.multipartEnabled !== undefined && typeof input.multipartEnabled !== 'boolean')
    invalid('multipartEnabled');
  const endpoint = normalizeEndpoint(input.endpoint);
  return {
    kind: 's3',
    ...(endpoint ? { endpoint } : {}),
    region,
    bucket: input.bucket,
    prefix: normalizeS3Prefix(input.prefix),
    pathStyle: input.pathStyle ?? false,
    signatureVersion,
    tlsVerify: input.tlsVerify ?? true,
    checksumMode,
    multipartPartSizeBytes: normalizePartSize(input.multipartPartSizeBytes),
    multipartEnabled: input.multipartEnabled ?? true,
  };
}

/**
 * Fields that decide where existing objects live. Changing one while Artifacts point at the backend
 * would make those Artifacts unreadable.
 */
export function storageLocationChanged(
  current: StorageBackendConfig,
  next: StorageBackendConfig,
): boolean {
  if (current.kind !== next.kind) return true;
  if (current.kind === 'filesystem' && next.kind === 'filesystem')
    return current.rootPath !== next.rootPath;
  if (current.kind === 's3' && next.kind === 's3')
    return (
      current.bucket !== next.bucket ||
      current.endpoint !== next.endpoint ||
      current.prefix !== next.prefix
    );
  return true;
}
