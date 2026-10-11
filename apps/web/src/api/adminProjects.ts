import type { AdminProject, AdminProjectQuery } from '@mmt/contracts';
import { encodeId, request, requestItems } from './http';

const adminProjectPath = (projectId?: string) =>
  `/admin/projects${projectId === undefined ? '' : `/${encodeId(projectId)}`}`;

/** The global administrator's Project list, with restoring and purging archived Projects. */
export const adminProjectsApi = {
  list: ({ includeArchived }: AdminProjectQuery, signal?: AbortSignal) =>
    requestItems<AdminProject>(
      `${adminProjectPath()}${includeArchived ? '?includeArchived=true' : ''}`,
      signal,
    ),
  restore: (projectId: string) =>
    request<AdminProject>(`${adminProjectPath(projectId)}/restore`, { method: 'POST' }),
  /** Removes an archived Project and all its data, Artifact files included. */
  purge: (projectId: string) =>
    request<void>(adminProjectPath(projectId), { method: 'DELETE' }),
};
