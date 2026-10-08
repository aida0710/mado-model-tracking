import type {
  ArtifactBackend,
  DatasetVersion,
  PluginConnection,
  PluginDataset,
  PluginManifest,
  Project,
  ProjectRole,
  TokenSummary,
} from '@mmt/contracts';
import type { CreateProject, CreateToken, ProjectMember } from './inputs';
import {
  encodeId,
  invalidResponseError,
  jsonRequest,
  projectPath,
  request,
  requestItems,
} from './http';

const pluginPath = (projectId: string, id?: string) =>
  `${projectPath(projectId)}/plugins${id ? `/${encodeId(id)}` : ''}`;
export const administrationApi = {
  projects: (signal?: AbortSignal) => requestItems<Project>('/projects', signal),
  createProject: (body: CreateProject) => request<Project>('/projects', jsonRequest('POST', body)),
  updateProject: (id: string, body: { description?: string; artifactBackend?: ArtifactBackend }) =>
    request<Project>(projectPath(id), jsonRequest('PATCH', body)),
  members: (id: string, signal?: AbortSignal) =>
    requestItems<ProjectMember>(`${projectPath(id)}/members`, signal),
  saveMember: (projectId: string, userId: string, role: ProjectRole) =>
    request<unknown>(
      `${projectPath(projectId)}/members/${encodeId(userId)}`,
      jsonRequest('PUT', { role }),
    ),
  tokens: (signal?: AbortSignal) => requestItems<TokenSummary>('/tokens', signal),
  createToken: (body: CreateToken) =>
    request<{ token: string; item: TokenSummary }>('/tokens', jsonRequest('POST', body)),
  revokeToken: (id: string) => request<unknown>(`/tokens/${encodeId(id)}`, { method: 'DELETE' }),
  plugins: (projectId: string, signal?: AbortSignal) =>
    requestItems<PluginConnection>(pluginPath(projectId), signal),
  createPlugin: (
    projectId: string,
    body: { name: string; baseUrl: string; tokenEnv: string; enabled?: boolean },
  ) => request<PluginConnection>(pluginPath(projectId), jsonRequest('POST', body)),
  updatePlugin: (
    projectId: string,
    id: string,
    body: { name?: string; baseUrl?: string; tokenEnv?: string; enabled?: boolean },
  ) => request<PluginConnection>(pluginPath(projectId, id), jsonRequest('PATCH', body)),
  checkPlugin: (projectId: string, id: string) =>
    request<PluginManifest>(`${pluginPath(projectId, id)}/check`, { method: 'POST' }),
  pluginMetrics: async (projectId: string, id: string, signal?: AbortSignal) => {
    const payload = await request<{ prometheus: string }>(`${pluginPath(projectId, id)}/metrics`, {
      signal,
    });
    if (typeof payload.prometheus !== 'string') throw invalidResponseError();
    return payload.prometheus;
  },
  searchDatasets: async (projectId: string, id: string, query: string) => {
    const payload = await request<{ items: PluginDataset[] }>(
      `${pluginPath(projectId, id)}/datasets/search`,
      jsonRequest('POST', { query }),
    );
    if (!Array.isArray(payload.items)) throw invalidResponseError();
    return payload.items;
  },
  importDataset: (projectId: string, id: string, dataset: PluginDataset) =>
    request<DatasetVersion>(
      `${pluginPath(projectId, id)}/datasets/import`,
      jsonRequest('POST', { dataset }),
    ),
  retryEvents: (projectId: string, id: string) =>
    request<{ queued: number }>(`${pluginPath(projectId, id)}/events/retry`, { method: 'POST' }),
};
