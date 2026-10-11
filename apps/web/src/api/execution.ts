import type {
  ComputeTargetDetails,
  ComputeTargetOverview,
  Job,
  JobListItem,
  JobRetryRequest,
  Run,
  RunCheckpointPage,
  WorkerPresence,
} from '@mmt/contracts';
import type { CreateJob, CreateTarget, UpdateTarget } from './inputs';
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
  /**
   * Every computer, someone else's private one too, with what anyone may know: no connection or
   * settings. Whether the signed-in person may use or manage each comes with it.
   */
  targetOverview: (signal?: AbortSignal) =>
    requestItems<ComputeTargetOverview>('/targets/overview', signal),
  /** The computers the signed-in person may use or manage, in full as far as they may see. */
  targets: (signal?: AbortSignal) => requestItems<ComputeTargetDetails>('/targets', signal),
  /** The computers the signed-in person may run Jobs on: public ones and their own. */
  projectTargets: (projectId: string, signal?: AbortSignal) =>
    requestItems<ComputeTargetDetails>(`/targets?${new URLSearchParams({ projectId })}`, signal),
  createTarget: (body: CreateTarget) =>
    request<ComputeTargetDetails>('/targets', jsonRequest('POST', body)),
  updateTarget: (id: string, body: UpdateTarget) =>
    request<ComputeTargetDetails>(`/targets/${encodeId(id)}`, jsonRequest('PATCH', body)),
  jobs: (projectId: string, signal?: AbortSignal) => requestItems<JobListItem>(jobPath(projectId), signal),
  createJob: (projectId: string, body: CreateJob) =>
    request<Job>(jobPath(projectId), jsonRequest('POST', body)),
  cancelJob: (projectId: string, id: string) =>
    request<unknown>(`${jobPath(projectId, id)}/cancel`, { method: 'POST' }),
  /** An empty request starts the new Run from scratch; see JobRetryRequest for a checkpoint. */
  retryJob: (projectId: string, id: string, body: JobRetryRequest) =>
    request<{ run: Run; job: Job }>(`${jobPath(projectId, id)}/retry`, jsonRequest('POST', body)),
  listRunCheckpoints,
  workers: (projectId: string, signal?: AbortSignal) =>
    requestItems<WorkerPresence>(`${projectPath(projectId)}/workers`, signal),
};
