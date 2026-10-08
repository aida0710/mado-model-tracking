import type { Artifact } from './index.js';

/** latest: per path, the Artifact a Run currently shows. all: every stored upload, older ones included. */
export type ArtifactListVersions = 'latest' | 'all';

/** One page of an Artifact list. nextCursor is absent on the last page. */
export interface ArtifactPage {
  items: Artifact[];
  nextCursor?: string;
}

/** A directory directly under the requested prefix; counts include every file below it. */
export interface ArtifactDirectoryEntry {
  /** Full directory path ending with `/`. */
  prefix: string;
  fileCount: number;
  totalSize: number;
}

/** GET /projects/:p/runs/:r/artifacts/tree: one directory level of a Run's latest Artifacts. */
export interface ArtifactTree {
  /** '' for the root, otherwise the directory path ending with `/`. */
  prefix: string;
  directories: ArtifactDirectoryEntry[];
  /** True when more child directories exist than the response holds. */
  directoriesTruncated: boolean;
  /** Files directly in this directory, without subdirectories. */
  fileCount: number;
  totalSize: number;
}
