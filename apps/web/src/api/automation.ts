import type {
  CreateAutomationExecution,
  ModelAutomationExecution,
  ModelAutomationExecutionPage,
  ModelAutomationRule,
} from '@mmt/contracts';
import type { CreateAutomationRule } from './inputs';
import {
  assertCursorPage,
  encodeId,
  jsonRequest,
  projectPath,
  request,
  requestItems,
} from './http';

// The API maximum: one polled page holds a version's executions.
export const VERSION_EXECUTION_PAGE_SIZE = 200;

const rulesPath = (projectId: string) => `${projectPath(projectId)}/automation-rules`;
export const automationApi = {
  rules: (projectId: string, signal?: AbortSignal) =>
    requestItems<ModelAutomationRule>(rulesPath(projectId), signal),
  createRule: (projectId: string, body: CreateAutomationRule) =>
    request<ModelAutomationRule>(rulesPath(projectId), jsonRequest('POST', body)),
  setRuleEnabled: (projectId: string, ruleId: string, enabled: boolean) =>
    request<ModelAutomationRule>(
      `${rulesPath(projectId)}/${encodeId(ruleId)}`,
      jsonRequest('PATCH', { enabled }),
    ),
  // Applies a rule to an existing version (or upstream Run) by hand; Project admin only.
  createExecution: (projectId: string, ruleId: string, body: CreateAutomationExecution) =>
    request<ModelAutomationExecution>(
      `${rulesPath(projectId)}/${encodeId(ruleId)}/executions`,
      jsonRequest('POST', body),
    ),
  // The newest page of the whole Project (the API default size).
  executions: (projectId: string, signal?: AbortSignal) =>
    requestItems<ModelAutomationExecution>(
      `${projectPath(projectId)}/automation-executions`,
      signal,
    ),
  versionExecutions: async (
    projectId: string,
    modelVersionId: string,
    signal?: AbortSignal,
  ): Promise<ModelAutomationExecutionPage> => {
    const query = new URLSearchParams({
      modelVersionId,
      limit: String(VERSION_EXECUTION_PAGE_SIZE),
    });
    const page = await request<ModelAutomationExecutionPage>(
      `${projectPath(projectId)}/automation-executions?${query}`,
      { signal },
    );
    assertCursorPage(page);
    return page;
  },
};
