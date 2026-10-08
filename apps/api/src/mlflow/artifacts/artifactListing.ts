import type { ArtifactFile, ArtifactPathEntry } from './artifactTypes.js';

export function listArtifactDirectory(
  artifacts: ArtifactPathEntry[],
  path: string,
): ArtifactFile[] {
  // A file is never also a directory; the service rejects conflicting uploads.
  if (artifacts.some((artifact) => artifact.path === path)) return [];
  const prefix = path ? `${path}/` : '';
  const children = new Map<string, ArtifactFile>();
  for (const artifact of artifacts) {
    if (!artifact.path.startsWith(prefix)) continue;
    const relativePath = artifact.path.slice(prefix.length);
    const [name, ...descendants] = relativePath.split('/');
    if (!name) continue;
    const childPath = `${prefix}${name}`;
    children.set(
      childPath,
      descendants.length
        ? { path: childPath, is_dir: true }
        : { path: childPath, is_dir: false, file_size: String(artifact.size) },
    );
  }
  return [...children.values()].sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
}
