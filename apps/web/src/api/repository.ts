import type { RepositoryFiles } from '@mmt/contracts';
import { jsonRequest, projectPath, request } from './http';

export const repositoryApi = {
  files: (projectId: string, source: { url: string; commit: string }, signal?: AbortSignal) =>
    request<RepositoryFiles>(`${projectPath(projectId)}/repository-files`, {
      ...jsonRequest('POST', source),
      signal,
    }),
};
