import type { CodeSource } from '@mmt/contracts';

export type GitRepository = Pick<Extract<CodeSource, { kind: 'git' }>, 'url' | 'commit'>;
export type RepositoryMode = 'same' | 'other' | 'standalone';
export interface CodeWorkspace {
  files: Record<string, string>;
  baseFiles: Record<string, string>;
  deletedFiles: string[];
  omittedPaths: string[];
  loadedRepository: GitRepository | null;
}
