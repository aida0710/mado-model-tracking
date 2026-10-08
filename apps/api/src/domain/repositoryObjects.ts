import type { RepositoryFiles } from '@mmt/contracts';
import { DomainError } from './errors.js';
import {
  isSafeCodePath,
  MAX_CODE_FILE_BYTES,
  MAX_CODE_FILES,
  MAX_CODE_TEXT_BYTES,
} from './codeSourceValidation.js';

// Trees include directories so even empty .git and unsafe directory names are rejected.
const MAX_REPOSITORY_ENTRIES = 10_000;
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
export interface RepositoryBlob {
  path: string;
  objectId: string;
  size: number;
}

function invalidRepository(): never {
  throw new DomainError(
    422,
    'Repositoryに安全に読み込めないファイルがあります',
    'unsafe_repository',
  );
}

export function parseRepositoryTree(tree: Buffer): RepositoryBlob[] {
  let listing: string;
  try {
    listing = utf8.decode(tree);
  } catch {
    invalidRepository();
  }
  const entries = listing.split('\0');
  if (entries.pop() !== '') invalidRepository();
  if (entries.length > MAX_REPOSITORY_ENTRIES)
    throw new DomainError(
      413,
      'Repositoryのファイル数が上限を超えています',
      'repository_too_large',
    );
  const blobs: RepositoryBlob[] = [];
  const paths = new Set<string>();
  for (const entry of entries) {
    const match = /^(\d{6}) (blob|tree|commit) ([a-f0-9]{40}|[a-f0-9]{64}) +(-|\d+)\t(.+)$/.exec(
      entry,
    );
    if (!match) invalidRepository();
    const [, mode, type, objectId, sizeText, filePath] = match as unknown as [
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    if (!isSafeCodePath(filePath) || filePath.length > 1024 || paths.has(filePath))
      invalidRepository();
    paths.add(filePath);
    if (mode === '040000' && type === 'tree' && sizeText === '-') continue;
    if (!['100644', '100755'].includes(mode) || type !== 'blob' || !/^\d+$/.test(sizeText))
      invalidRepository();
    const size = Number(sizeText);
    if (!Number.isSafeInteger(size)) invalidRepository();
    blobs.push({ path: filePath, objectId, size });
  }
  return blobs;
}

export function selectRepositoryBlobs(blobs: RepositoryBlob[]): {
  selected: RepositoryBlob[];
  omittedPaths: string[];
} {
  const selected: RepositoryBlob[] = [];
  const omittedPaths: string[] = [];
  let bytes = 0;
  for (const blob of blobs) {
    if (
      blob.size > MAX_CODE_FILE_BYTES ||
      bytes + blob.size > MAX_CODE_TEXT_BYTES ||
      selected.length >= MAX_CODE_FILES
    ) {
      omittedPaths.push(blob.path);
      continue;
    }
    selected.push(blob);
    bytes += blob.size;
  }
  return { selected, omittedPaths };
}

export function decodeRepositoryBlobs(request: {
  commit: string;
  selected: RepositoryBlob[];
  omittedPaths: string[];
  contents: Buffer;
}): RepositoryFiles {
  const files: Record<string, string> = Object.create(null) as Record<string, string>;
  const omittedPaths = [...request.omittedPaths];
  let offset = 0;
  for (const blob of request.selected) {
    const headerEnd = request.contents.indexOf('\n', offset);
    if (headerEnd < 0) invalidRepository();
    const header = request.contents.subarray(offset, headerEnd).toString('ascii');
    if (header !== `${blob.objectId} blob ${blob.size}`) invalidRepository();
    const start = headerEnd + 1;
    const end = start + blob.size;
    if (request.contents[end] !== 10) invalidRepository();
    const content = request.contents.subarray(start, end);
    offset = end + 1;
    if (content.includes(0)) {
      omittedPaths.push(blob.path);
      continue;
    }
    try {
      files[blob.path] = utf8.decode(content);
    } catch {
      omittedPaths.push(blob.path);
    }
  }
  if (offset !== request.contents.length) invalidRepository();
  return { commit: request.commit, files, omittedPaths: omittedPaths.sort() };
}
