import type { ExperimentTask, TaskExecution, TaskRunPage } from '@mmt/contracts';
import type { CreateTask, LaunchTask, UpdateTask } from './inputs';
import { encodeId, jsonRequest, projectPath, request, requestItems } from './http';
import { text } from '../i18n/catalog';

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
      throw new Error(text.invalidResponse);
    return page;
  },
};
