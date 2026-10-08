import type {
  ComputeTarget,
  Job,
  JobListItem,
  JobRetryRequest,
  Run,
  RunCheckpointPage,
  WorkerPresence,
} from '@mmt/contracts';
import type { CreateTarget } from './inputs';
import {
  encodeId,
  invalidResponseError,
  jsonRequest,
  projectPath,
  request,
  requestItems,
} from './http';

const jobPath = (projectId: string, jobId?: string) =>
  `${projectPath(projectId)}/jobs${jobId ? `/${encodeId(jobId)}` : ''}`;
const runCheckpointsPath = (projectId: string, runId: string) =>
  `${projectPath(projectId)}/runs/${encodeId(runId)}/checkpoints`;

export interface RunCheckpointQuery {
  /** Also list checkpoints beyond the keep count (retained=false); they can still be resumed. */
  includeHidden?: boolean;
}

/** A Run's checkpoints, largest step first. */
async function listRunCheckpoints(
  projectId: string,
  runId: string,
  query: RunCheckpointQuery,
  signal?: AbortSignal,
): Promise<RunCheckpointPage> {
  const search = query.includeHidden ? '?includeHidden=true' : '';
  const path = `${runCheckpointsPath(projectId, runId)}${search}`;
  const page = await request<RunCheckpointPage>(path, { signal });
  if (!Array.isArray(page.items)) throw invalidResponseError();
  return page;
}

export const executionApi = {
  targets: (signal?: AbortSignal) => requestItems<ComputeTarget>('/targets', signal),
  createTarget: (body: CreateTarget) =>
    request<ComputeTarget>('/targets', jsonRequest('POST', body)),
  updateTarget: (id: string, body: Partial<CreateTarget>) =>
    request<ComputeTarget>(`/targets/${encodeId(id)}`, jsonRequest('PATCH', body)),
  jobs: (projectId: string, signal?: AbortSignal) => requestItems<JobListItem>(jobPath(projectId), signal),
  createJob: (
    projectId: string,
    body: { runId: string; targetId: string; gpuIds: string[]; maxAttempts: number },
  ) => request<Job>(jobPath(projectId), jsonRequest('POST', body)),
  cancelJob: (projectId: string, id: string) =>
    request<unknown>(`${jobPath(projectId, id)}/cancel`, { method: 'POST' }),
  /** An empty request starts the new Run from scratch; see JobRetryRequest for a checkpoint. */
  retryJob: (projectId: string, id: string, body: JobRetryRequest) =>
    request<{ run: Run; job: Job }>(`${jobPath(projectId, id)}/retry`, jsonRequest('POST', body)),
  listRunCheckpoints,
  workers: (projectId: string, signal?: AbortSignal) =>
    requestItems<WorkerPresence>(`${projectPath(projectId)}/workers`, signal),
};
