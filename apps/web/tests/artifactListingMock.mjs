// The Artifact list rules of docs/api-contract.md for browser checks: latest per path, byte-order
// paths, prefix/delimiter, directory tree, and cursors. Cursors are plain offsets here.

const byPathThenNewest = (left, right) =>
  left.path === right.path
    ? right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id)
    : Buffer.compare(Buffer.from(left.path), Buffer.from(right.path));

function latestPerPath(artifacts) {
  const seen = new Set();
  return [...artifacts].sort(byPathThenNewest).filter((artifact) => {
    if (seen.has(artifact.path)) return false;
    seen.add(artifact.path);
    return true;
  });
}

function page(items, searchParams, defaultLimit) {
  const offset = Number(searchParams.get('cursor') ?? 0);
  const limit = Number(searchParams.get('limit') ?? defaultLimit);
  const next = offset + limit;
  return {
    items: items.slice(offset, next),
    ...(next < items.length ? { nextCursor: String(next) } : {}),
  };
}

export function listRunArtifacts(artifacts, runId, searchParams) {
  const prefix = searchParams.get('prefix') ?? '';
  const directOnly = searchParams.get('delimiter') === '/';
  const ofRun = artifacts.filter((artifact) => artifact.runId === runId);
  const versions =
    searchParams.get('versions') === 'all' ? [...ofRun].sort(byPathThenNewest) : latestPerPath(ofRun);
  const listed = versions.filter(
    (artifact) =>
      artifact.path.startsWith(prefix) &&
      (!directOnly || !artifact.path.slice(prefix.length).includes('/')),
  );
  return page(listed, searchParams, 1000);
}

export function runArtifactTree(artifacts, runId, searchParams) {
  const raw = searchParams.get('prefix') ?? '';
  const prefix = raw === '' || raw.endsWith('/') ? raw : `${raw}/`;
  const directories = new Map();
  let fileCount = 0;
  let totalSize = 0;
  for (const artifact of latestPerPath(artifacts.filter((item) => item.runId === runId))) {
    if (!artifact.path.startsWith(prefix)) continue;
    const rest = artifact.path.slice(prefix.length);
    if (!rest.includes('/')) {
      fileCount += 1;
      totalSize += artifact.size;
      continue;
    }
    const directory = `${prefix}${rest.split('/')[0]}/`;
    const entry = directories.get(directory) ?? { prefix: directory, fileCount: 0, totalSize: 0 };
    entry.fileCount += 1;
    entry.totalSize += artifact.size;
    directories.set(directory, entry);
  }
  return {
    prefix,
    directories: [...directories.values()].sort((left, right) =>
      Buffer.compare(Buffer.from(left.prefix), Buffer.from(right.prefix)),
    ),
    directoriesTruncated: false,
    fileCount,
    totalSize,
  };
}

export function listProjectArtifacts(artifacts, searchParams) {
  const query = searchParams.get('query');
  const mimeType = searchParams.get('mimeType');
  const runId = searchParams.get('runId');
  const source = searchParams.get('versions') === 'latest' ? latestPerPath(artifacts) : artifacts;
  const listed = source
    .filter(
      (artifact) =>
        (!query || artifact.path.includes(query)) &&
        (!mimeType ||
          (mimeType.endsWith('/*')
            ? artifact.mimeType.startsWith(mimeType.slice(0, -1))
            : artifact.mimeType.split(';')[0] === mimeType)) &&
        (!runId || artifact.runId === runId),
    )
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id));
  return page(listed, searchParams, 100);
}
