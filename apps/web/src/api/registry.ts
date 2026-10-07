import type {
  Code,
  CodeVersion,
  Dataset,
  DatasetVersion,
  Model,
  ModelVersion,
} from '@mmt/contracts';
import type { CreateCodeVersion, CreateDatasetVersion, CreateModelVersion } from './inputs';
import { encodeId, jsonRequest, projectPath, request, requestItems } from './http';

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
  assignAlias: (projectId: string, id: string, alias: string, versionId: string) =>
    request<unknown>(
      `${registryPath(projectId, 'models', id)}/aliases/${encodeId(alias)}`,
      jsonRequest('PUT', { versionId }),
    ),
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
