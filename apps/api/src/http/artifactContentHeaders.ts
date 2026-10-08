import type { Artifact } from '@mmt/contracts';
import type { ArtifactContent } from '@mmt/platform';
import { isInlineArtifactMimeType } from '../domain/artifactMimeType.js';

// Artifact ids never change content, so a year-long private cache is safe for native content URLs.
export const IMMUTABLE_ARTIFACT_CACHE_CONTROL = 'private, max-age=31536000, immutable';
// MLflow paths can be re-pointed to another Artifact, so their responses must not be cached.
export const MUTABLE_ARTIFACT_CACHE_CONTROL = 'private, no-store';

export type ArtifactDisposition = 'inline-when-safe' | 'attachment';

export function artifactEntityTag(artifact: Pick<Artifact, 'sha256'>): string {
  return `"sha256-${artifact.sha256}"`;
}

function encodeFilename(filename: string): string {
  // RFC 5987 leaves these characters unreserved, but some clients mis-parse them in filename*.
  return encodeURIComponent(filename).replace(
    /['()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function contentDisposition(artifact: Artifact, disposition: ArtifactDisposition): string {
  const isInline =
    disposition === 'inline-when-safe' && isInlineArtifactMimeType(artifact.mimeType);
  const filename = artifact.path.split('/').at(-1)!;
  return `${isInline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeFilename(filename)}`;
}

/** Headers shared by full, partial, and not-modified responses for one Artifact. */
export function artifactValidatorHeaders(
  artifact: Artifact,
  cacheControl: string,
): Record<string, string> {
  return { ETag: artifactEntityTag(artifact), 'Cache-Control': cacheControl };
}

export function artifactContentHeaders(download: {
  artifact: Artifact;
  content: ArtifactContent;
  disposition: ArtifactDisposition;
  cacheControl: string;
}): Record<string, string> {
  const { artifact, content } = download;
  const headers: Record<string, string> = {
    ...artifactValidatorHeaders(artifact, download.cacheControl),
    'Content-Type': artifact.mimeType,
    'Content-Length': String(content.size),
    'Accept-Ranges': 'bytes',
    'Content-Disposition': contentDisposition(artifact, download.disposition),
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "sandbox; default-src 'none'",
  };
  if (content.contentRange) headers['Content-Range'] = content.contentRange;
  return headers;
}

function entityTagList(header: string): string[] {
  return header.split(',').map((tag) => tag.trim());
}

/** If-None-Match uses weak comparison, so a W/ prefix from an intermediary still matches. */
export function matchesIfNoneMatch(header: string | undefined, artifact: Artifact): boolean {
  if (!header) return false;
  const entityTag = artifactEntityTag(artifact);
  return entityTagList(header).some((tag) => tag === '*' || tag.replace(/^W\//, '') === entityTag);
}

/**
 * If-Range requires strong comparison. Artifacts expose no Last-Modified, so a date never matches
 * and the client receives the whole representation, which is always correct.
 */
export function shouldServeRange(ifRangeHeader: string | undefined, artifact: Artifact): boolean {
  if (!ifRangeHeader) return true;
  return ifRangeHeader.trim() === artifactEntityTag(artifact);
}
