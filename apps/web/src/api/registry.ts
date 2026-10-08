import type {
  Code,
  CodeVersion,
  Dataset,
  DatasetVersion,
  Model,
  ModelAliasEventPage,
  ModelVersion,
} from '@mmt/contracts';
import type { CreateCodeVersion, CreateDatasetVersion, CreateModelVersion } from './inputs';
import {
  encodeId,
  invalidResponseError,
  jsonRequest,
  projectPath,
  request,
  requestItems,
} from './http';

// Matches the API limit so the form stops input the server would reject.
export const MAX_MODEL_ALIAS_REASON_LENGTH = 2000;
// Matches the API default so each "load more" fetches one server page.
export const MODEL_ALIAS_EVENT_PAGE_SIZE = 50;

export interface ModelAliasAssignment {
  alias: string;
  versionId: string;
  /** Empty means no reason; the API stores it as ''. */
  reason: string;
}

const registryPath = (projectId: string, registry: string, id?: string) =>
  `${projectPath(projectId)}/${registry}${id ? `/${encodeId(id)}` : ''}`;
export const registryApi = {
  models: (projectId: string, signal?: AbortSignal) =>
    requestItems<Model>(registryPath(projectId, 'models'), signal),
  createModel: (projectId: string, body: { name: string; family: string; description?: string }) =>
    request<Model>(registryPath(projectId, 'models'), jsonRequest('POST', body)),
  modelVersions: (projectId: string, id: string, signal?: AbortSignal) =>
    requestItems<ModelVersion>(`${registryPath(projectId, 'models', id)}/versions`, signal),
  createModelVersion: (projectId: string, id: string, body: CreateModelVersion) =>
    request<ModelVersion>(
      `${registryPath(projectId, 'models', id)}/versions`,
      jsonRequest('POST', body),
    ),
  assignAlias: (projectId: string, id: string, assignment: ModelAliasAssignment) =>
    request<Model>(
      `${registryPath(projectId, 'models', id)}/aliases/${encodeId(assignment.alias)}`,
      jsonRequest('PUT', {
        versionId: assignment.versionId,
        ...(assignment.reason ? { reason: assignment.reason } : {}),
      }),
    ),
  removeAlias: (projectId: string, id: string, alias: string) =>
    request<void>(`${registryPath(projectId, 'models', id)}/aliases/${encodeId(alias)}`, {
      method: 'DELETE',
    }),
  aliasEvents: async (
    projectId: string,
    id: string,
    { cursor, signal }: { cursor?: string; signal?: AbortSignal } = {},
  ): Promise<ModelAliasEventPage> => {
    const query = new URLSearchParams({ limit: String(MODEL_ALIAS_EVENT_PAGE_SIZE) });
    if (cursor) query.set('cursor', cursor);
    const page = await request<ModelAliasEventPage>(
      `${registryPath(projectId, 'models', id)}/alias-events?${query}`,
      { signal },
    );
    if (
      !Array.isArray(page.items) ||
      (page.nextCursor !== null && typeof page.nextCursor !== 'string')
    )
      throw invalidResponseError();
    return page;
  },
  codes: (projectId: string, signal?: AbortSignal) =>
    requestItems<Code>(registryPath(projectId, 'codes'), signal),
  createCode: (projectId: string, body: { name: string; description?: string }) =>
    request<Code>(registryPath(projectId, 'codes'), jsonRequest('POST', body)),
  codeVersions: (projectId: string, id: string, signal?: AbortSignal) =>
    requestItems<CodeVersion>(`${registryPath(projectId, 'codes', id)}/versions`, signal),
  createCodeVersion: (projectId: string, id: string, body: CreateCodeVersion) =>
    request<CodeVersion>(
      `${registryPath(projectId, 'codes', id)}/versions`,
      jsonRequest('POST', body),
    ),
  datasets: (projectId: string, signal?: AbortSignal) =>
    requestItems<Dataset>(registryPath(projectId, 'datasets'), signal),
  createDataset: (
    projectId: string,
    body: { name: string; namespace?: string; description?: string },
  ) => request<Dataset>(registryPath(projectId, 'datasets'), jsonRequest('POST', body)),
  datasetVersions: (projectId: string, id: string, signal?: AbortSignal) =>
    requestItems<DatasetVersion>(`${registryPath(projectId, 'datasets', id)}/versions`, signal),
  createDatasetVersion: (projectId: string, id: string, body: CreateDatasetVersion) =>
    request<DatasetVersion>(
      `${registryPath(projectId, 'datasets', id)}/versions`,
      jsonRequest('POST', body),
    ),
};
