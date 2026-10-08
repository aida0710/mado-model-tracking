import type {
  Artifact,
  Experiment,
  LineageGraph,
  LogEntry,
  MetricPoint,
  Run,
} from '@mmt/contracts';
import type { CreateRun, UpdateRun } from './inputs';
import { encodeId, jsonRequest, projectPath, request, requestItems } from './http';

const runPath = (projectId: string, runId: string) =>
  `${projectPath(projectId)}/runs/${encodeId(runId)}`;
export const trackingApi = {
  experiments: (projectId: string, signal?: AbortSignal) =>
    requestItems<Experiment>(`${projectPath(projectId)}/experiments`, signal),
  createExperiment: (projectId: string, body: { name: string; description?: string }) =>
    request<Experiment>(`${projectPath(projectId)}/experiments`, jsonRequest('POST', body)),
  runs: (projectId: string, query: Record<string, string>, signal?: AbortSignal) =>
    requestItems<Run>(`${projectPath(projectId)}/runs?${new URLSearchParams(query)}`, signal),
  run: (projectId: string, runId: string, signal?: AbortSignal) =>
    request<Run>(runPath(projectId, runId), { signal }),
  createRun: (projectId: string, body: CreateRun) =>
    request<Run>(`${projectPath(projectId)}/runs`, jsonRequest('POST', body)),
  updateRun: (projectId: string, runId: string, body: UpdateRun) =>
    request<Run>(runPath(projectId, runId), jsonRequest('PATCH', body)),
  metrics: (projectId: string, runId: string, signal?: AbortSignal) =>
    requestItems<MetricPoint>(`${runPath(projectId, runId)}/metrics`, signal),
  logs: (projectId: string, runId: string, signal?: AbortSignal) =>
    requestItems<LogEntry>(`${runPath(projectId, runId)}/logs`, signal),
  artifacts: (projectId: string, runId: string, signal?: AbortSignal) =>
    requestItems<Artifact>(`${runPath(projectId, runId)}/artifacts`, signal),
  projectArtifacts: (
    projectId: string,
    query: { limit: number; query?: string },
    signal?: AbortSignal,
  ) =>
    requestItems<Artifact>(
      `${projectPath(projectId)}/artifacts?${new URLSearchParams({ limit: String(query.limit), ...(query.query ? { query: query.query } : {}) })}`,
      signal,
    ),
  uploadArtifact: (projectId: string, runId: string | null, path: string, file: File) =>
    request<Artifact>(
      `${runId ? runPath(projectId, runId) : projectPath(projectId)}/artifacts?${new URLSearchParams({ path })}`,
      {
        method: 'PUT',
        body: file,
        headers: { 'Content-Type': file.type || 'application/octet-stream' },
      },
    ),
  artifactUrl: (projectId: string, artifactId: string) =>
    `/api${projectPath(projectId)}/artifacts/${encodeId(artifactId)}/content`,
  lineage: (projectId: string, signal?: AbortSignal) =>
    request<LineageGraph>(`${projectPath(projectId)}/lineage`, { signal }),
};
