import type { ComputeTarget, Job, Run } from '@mmt/contracts';
import type { CreateTarget } from './inputs';
import { encodeId, jsonRequest, projectPath, request, requestItems } from './http';

const jobPath = (projectId: string, jobId?: string) =>
  `${projectPath(projectId)}/jobs${jobId ? `/${encodeId(jobId)}` : ''}`;
export const executionApi = {
  targets: (signal?: AbortSignal) => requestItems<ComputeTarget>('/targets', signal),
  createTarget: (body: CreateTarget) =>
    request<ComputeTarget>('/targets', jsonRequest('POST', body)),
  jobs: (projectId: string, signal?: AbortSignal) => requestItems<Job>(jobPath(projectId), signal),
  createJob: (
    projectId: string,
    body: { runId: string; targetId: string; gpuIds: string[]; maxAttempts: number },
  ) => request<Job>(jobPath(projectId), jsonRequest('POST', body)),
  cancelJob: (projectId: string, id: string) =>
    request<unknown>(`${jobPath(projectId, id)}/cancel`, { method: 'POST' }),
  retryJob: (projectId: string, id: string) =>
    request<{ run: Run; job: Job }>(`${jobPath(projectId, id)}/retry`, { method: 'POST' }),
};
