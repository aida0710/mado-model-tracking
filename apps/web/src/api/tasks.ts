import type { ExperimentTask, RunOutputRegistration, TaskExecution, TaskRunPage } from '@mmt/contracts';
import type { CreateTask, LaunchTask, UpdateTask } from './inputs';
import { encodeId, invalidResponseError, jsonRequest, projectPath, request, RequestError, requestItems } from './http';

const HTTP_NOT_FOUND = 404;
const REGISTRATION_STATUSES: RunOutputRegistration['status'][] = ['registered', 'failed', 'skipped'];

// Match the API's bounded default rather than polling the entire task history.
const TASK_RUN_PAGE_SIZE = 50;

const taskPath = (projectId: string, id?: string) =>
  `${projectPath(projectId)}/tasks${id ? `/${encodeId(id)}` : ''}`;

export const tasksApi = {
  list: (projectId: string, experimentId?: string, signal?: AbortSignal) =>
    requestItems<ExperimentTask>(
      `${taskPath(projectId)}${experimentId ? `?${new URLSearchParams({ experimentId })}` : ''}`,
      signal,
    ),
  create: (projectId: string, input: CreateTask) =>
    request<ExperimentTask>(taskPath(projectId), jsonRequest('POST', input)),
  update: (projectId: string, id: string, input: UpdateTask) =>
    request<ExperimentTask>(taskPath(projectId, id), jsonRequest('PATCH', input)),
  launch: (projectId: string, id: string, input: LaunchTask) =>
    request<TaskExecution>(`${taskPath(projectId, id)}/launch`, jsonRequest('POST', input)),
  runs: async (projectId: string, id: string, { cursor, signal }: { cursor?: string; signal?: AbortSignal } = {}) => {
    const query = new URLSearchParams({ limit: String(TASK_RUN_PAGE_SIZE) });
    if (cursor) query.set('cursor', cursor);
    const page = await request<TaskRunPage>(`${taskPath(projectId, id)}/runs?${query}`, { signal });
    if (!Array.isArray(page.items) || (page.nextCursor !== null && typeof page.nextCursor !== 'string'))
      throw invalidResponseError();
    return page;
  },
  /** null until the Task-side registration has an outcome: the API answers 204 or 404 then. */
  runOutputRegistration: async (projectId: string, runId: string, signal?: AbortSignal) => {
    try {
      const registration = await request<RunOutputRegistration | undefined>(
        `${projectPath(projectId)}/runs/${encodeId(runId)}/output-registration`, { signal });
      if (registration && !REGISTRATION_STATUSES.includes(registration.status)) throw invalidResponseError();
      return registration ?? null;
    } catch (error) {
      if (error instanceof RequestError && error.status === HTTP_NOT_FOUND) return null;
      throw error;
    }
  },
};
