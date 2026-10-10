import type {
  Hook,
  HookCreate,
  HookCreated,
  HookExecution,
  HookExecutionPage,
  HookOwnerTransfer,
  HookToggle,
  HookTriggerRequest,
} from '@mmt/contracts';
import {
  assertCursorPage,
  encodeId,
  invalidResponseError,
  jsonRequest,
  projectPath,
  request,
  requestItems,
} from './http';

// One page of the executions table; the API caps the page size on its side.
export const HOOK_EXECUTION_PAGE_SIZE = 50;

const hooksPath = (projectId: string, hookId?: string) =>
  `${projectPath(projectId)}/hooks${hookId ? `/${encodeId(hookId)}` : ''}`;

export interface HookExecutionQuery {
  /** Only this hook's executions; every hook of the Project when omitted. */
  hookId?: string;
  cursor?: string;
  limit?: number;
}

async function createHook(projectId: string, body: HookCreate): Promise<HookCreated> {
  const created = await request<HookCreated>(hooksPath(projectId), jsonRequest('POST', body));
  // The secret is shown once; a response without the hook cannot be shown or retried safely.
  if (typeof created.hook?.id !== 'string') throw invalidResponseError(201);
  return created;
}

/** The Project's hook executions, newest first, one cursor page at a time. */
async function listExecutions(
  projectId: string,
  query: HookExecutionQuery,
  signal?: AbortSignal,
): Promise<HookExecutionPage> {
  const search = new URLSearchParams({ limit: String(query.limit ?? HOOK_EXECUTION_PAGE_SIZE) });
  if (query.hookId) search.set('hookId', query.hookId);
  if (query.cursor) search.set('cursor', query.cursor);
  const page = await request<HookExecutionPage>(
    `${projectPath(projectId)}/hook-executions?${search}`,
    { signal },
  );
  assertCursorPage(page);
  return page;
}

export const hooksApi = {
  list: (projectId: string, signal?: AbortSignal) =>
    requestItems<Hook>(hooksPath(projectId), signal),
  /** The webhook secret and path of a 'webhook' hook come back only in this response. */
  create: createHook,
  setEnabled: (projectId: string, hookId: string, enabled: boolean) =>
    request<Hook>(
      hooksPath(projectId, hookId),
      jsonRequest('PATCH', { enabled } satisfies HookToggle),
    ),
  /** Runs the hook as a Service Account of the Project from now on; Project admin only. */
  transferOwner: (projectId: string, hookId: string, body: HookOwnerTransfer) =>
    request<Hook>(`${hooksPath(projectId, hookId)}/owner`, jsonRequest('PUT', body)),
  /** Starts a 'manual' hook; a resend with the same idempotencyKey returns the first start. */
  trigger: (projectId: string, hookId: string, body: HookTriggerRequest) =>
    request<HookExecution>(`${hooksPath(projectId, hookId)}/trigger`, jsonRequest('POST', body)),
  executions: listExecutions,
};
