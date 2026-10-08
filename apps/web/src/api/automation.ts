import type { ModelAutomationExecution, ModelAutomationRule } from '@mmt/contracts';
import type { CreateAutomationRule } from './inputs';
import { encodeId, jsonRequest, projectPath, request, requestItems } from './http';

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
  executions: (projectId: string, signal?: AbortSignal) =>
    requestItems<ModelAutomationExecution>(
      `${projectPath(projectId)}/automation-executions`,
      signal,
    ),
};
