import { createHash } from 'node:crypto';

/** What the digest covers for each file; the Artifact ID is left out so re-uploads keep the digest. */
export interface DatasetManifestEntry {
  path: string;
  sha256: string;
  size: number;
}

const DIGEST_PREFIX = 'sha256:';

/** Orders paths by their UTF-8 bytes, the same order as PostgreSQL's C collation. */
export function compareManifestPaths(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

/**
 * `sha256:` + hex SHA-256 of the canonical manifest: a JSON array of `{"path","sha256","size"}`
 * objects in UTF-8 byte order of path, keys in that order, without whitespace, non-ASCII left
 * unescaped. Python reproduces it with `json.dumps(entries, separators=(",", ":"),
 * ensure_ascii=False)`, so clients can check a version against local files.
 */
export function datasetManifestDigest(entries: readonly DatasetManifestEntry[]): string {
  const canonical = [...entries]
    .sort((left, right) => compareManifestPaths(left.path, right.path))
    .map((entry) => ({ path: entry.path, sha256: entry.sha256, size: entry.size }));
  return DIGEST_PREFIX + createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex');
}
