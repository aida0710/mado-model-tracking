import { z } from 'zod';
import { MULTIPART_MAX_PART_COUNT } from '@mmt/platform';
import { DomainError } from '../../domain/errors.js';
import { uuidSchema } from '../../domain/validation.js';
import { parseArtifactLocation, validateArtifactPath } from './artifactPath.js';
import type { ArtifactLocation } from './artifactTypes.js';

export const MULTIPART_UPLOAD_ROOT = '/api/2.0/mlflow-artifacts/mpu';
/**
 * MLflow's _upload_part sends only credential.headers, never Authorization, so the session's part
 * token travels in this header.
 */
export const PART_TOKEN_HEADER = 'X-MMT-Upload-Token';
export const MULTIPART_PART_ROUTE = `${MULTIPART_UPLOAD_ROOT}/parts/:uploadId/:partNumber`;

export type MultipartAction = 'create' | 'complete' | 'abort';

// MLflow sends the client's local file path; only its file name becomes part of the Artifact path.
const localPathSchema = z.string().min(1).max(4096);
// Protobuf JSON may omit zero-valued num_parts, which an empty file produces.
export const createMultipartRequestSchema = z.object({
  path: localPathSchema,
  num_parts: z.coerce.number().int().min(0).max(MULTIPART_MAX_PART_COUNT).default(0),
});
export const completeMultipartRequestSchema = z.object({
  path: localPathSchema,
  upload_id: uuidSchema,
  parts: z
    .array(
      z.object({
        part_number: z.coerce.number().int().min(1).max(MULTIPART_MAX_PART_COUNT),
        etag: z.string().max(200).nullish(),
        url: z.string().nullish(),
      }),
    )
    .max(MULTIPART_MAX_PART_COUNT),
});
export const abortMultipartRequestSchema = z.object({
  path: localPathSchema,
  upload_id: uuidSchema,
});
export const partNumberSchema = z.coerce.number().int().min(1).max(MULTIPART_MAX_PART_COUNT);

/** Parses the Artifact directory after `mpu/<action>/`; logging at the root has no directory. */
export function decodeMultipartDirectory(encodedPath: string): ArtifactLocation {
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(encodedPath);
  } catch {
    throw new DomainError(422, 'Artifactパスが不正です', 'invalid_parameter_value');
  }
  return parseArtifactLocation(decodedPath, { directory: true });
}

/** The encoded `<runs|models>/<id>/artifacts/<directory>` part of an mpu request path. */
export function encodedMultipartTarget(requestPath: string, action: MultipartAction): string {
  const prefix = `${MULTIPART_UPLOAD_ROOT}/${action}/`;
  const position = requestPath.indexOf(prefix);
  if (position < 0) throw new DomainError(422, 'Artifactパスが不正です', 'invalid_parameter_value');
  return requestPath.slice(position + prefix.length);
}

/** Same as MLflow's server: `<directory>/<basename of the client's local path>`. */
export function multipartArtifactLocation(
  directory: ArtifactLocation,
  localPath: string,
): ArtifactLocation {
  // Windows clients send backslash-separated paths.
  const fileName = localPath.split(/[\\/]/).at(-1) ?? '';
  const path = directory.path ? `${directory.path}/${fileName}` : fileName;
  return { owner: directory.owner, path: validateArtifactPath(path) };
}

/**
 * The SDK copies the ETag response header into complete's parts. The part's SHA-256 is used so
 * complete can tell that a part was replaced after the client sent it.
 */
export function partEtag(sha256: string): string {
  return `"${sha256}"`;
}

export function partSha256FromEtag(etag: string | null | undefined): string | null {
  if (!etag) return null;
  const digest = /^"?([0-9a-f]{64})"?$/i.exec(etag)?.[1];
  if (!digest) throw new DomainError(422, 'partのETagが不正です', 'invalid_parameter_value');
  return digest.toLowerCase();
}

export function createMultipartResponse(created: {
  uploadId: string;
  partToken: string;
  partCount: number;
  /** Absolute URL of `.../mpu/parts`; requests.put in the SDK needs an absolute URL. */
  partsUrl: string;
}) {
  return {
    upload_id: created.uploadId,
    credentials: Array.from({ length: created.partCount }, (_, index) => ({
      url: `${created.partsUrl}/${created.uploadId}/${index + 1}`,
      part_number: index + 1,
      headers: { [PART_TOKEN_HEADER]: created.partToken },
    })),
  };
}

/**
 * Absolute `.../mpu/parts` URL on the origin the client used. nginx and the Web dev proxy keep the
 * Host header; nginx reports TLS termination through X-Forwarded-Proto. The URL is returned only
 * to the requesting client, so a spoofed header can only misdirect that client's own parts.
 */
export function multipartPartsUrl(requestUrl: string, forwardedProtocol?: string): string {
  const url = new URL(requestUrl);
  if (forwardedProtocol === 'http' || forwardedProtocol === 'https')
    url.protocol = `${forwardedProtocol}:`;
  const mountPath = url.pathname.slice(0, url.pathname.indexOf(MULTIPART_UPLOAD_ROOT));
  return `${url.origin}${mountPath}${MULTIPART_UPLOAD_ROOT}/parts`;
}
