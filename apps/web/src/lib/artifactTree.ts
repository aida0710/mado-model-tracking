import type { Artifact, ArtifactDirectoryEntry, ArtifactTree } from '@mmt/contracts';

/** One step of the path shown above a directory. The root has name '' and prefix ''. */
export interface ArtifactBreadcrumb {
  name: string;
  prefix: string;
}

export type ArtifactBrowserRow =
  | { kind: 'directory'; key: string; name: string; directory: ArtifactDirectoryEntry }
  | { kind: 'file'; key: string; name: string; artifact: Artifact };

/**
 * Root first. Segments are shown exactly as stored: `..` and empty segments are names, never
 * resolved, so each breadcrumb opens the same prefix the API listed.
 */
export function artifactBreadcrumbs(prefix: string): ArtifactBreadcrumb[] {
  const breadcrumbs: ArtifactBreadcrumb[] = [{ name: '', prefix: '' }];
  let current = '';
  for (const segment of prefix.split('/').slice(0, -1)) {
    current += `${segment}/`;
    breadcrumbs.push({ name: segment, prefix: current });
  }
  return breadcrumbs;
}

/** The part of a path below the open directory; '' when nothing remains to show. */
export function artifactEntryName(path: string, prefix: string): string {
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

function directoryName(directory: ArtifactDirectoryEntry, prefix: string): string {
  return artifactEntryName(directory.prefix, prefix).replace(/\/$/, '');
}

// Digits compare as numbers, so step-9 comes before step-19 as file managers show them.
const directoryNameCollator = new Intl.Collator('en', { numeric: true });

/**
 * Directories first, then files, as file managers show them. A file and a directory with the
 * same name are both listed; their keys differ by kind. Directories arrive all at once and are
 * re-sorted by name; files keep the API's page order so loading the next page only appends.
 */
export function artifactDirectoryRows(tree: ArtifactTree, files: Artifact[]): ArtifactBrowserRow[] {
  return [
    ...tree.directories
      .map((directory): ArtifactBrowserRow & { kind: 'directory' } => ({
        kind: 'directory',
        key: `directory:${directory.prefix}`,
        name: directoryName(directory, tree.prefix),
        directory,
      }))
      .sort((left, right) => directoryNameCollator.compare(left.name, right.name)),
    ...files.map((artifact): ArtifactBrowserRow => ({
      kind: 'file',
      key: `file:${artifact.id}`,
      name: artifactEntryName(artifact.path, tree.prefix),
      artifact,
    })),
  ];
}

/** Older uploads at the same path, newest first, without the one being shown. */
export function previousArtifactVersions(versions: Artifact[], current: Artifact): Artifact[] {
  return versions.filter((item) => item.path === current.path && item.id !== current.id);
}
