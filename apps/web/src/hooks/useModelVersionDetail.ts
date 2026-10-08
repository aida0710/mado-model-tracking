import type { Run } from '@mmt/contracts';
import { automationApi } from '../api/automation';
import { registryApi } from '../api/registry';
import { trackingApi } from '../api/tracking';
import { hasActiveExecution, hasActiveRun } from '../lib/automationActivity';
import { useQuery } from './useQuery';
import { useQueryPolledWhileActive } from './useQueryPolledWhileActive';

/** The version, its training Run, the Project's rules, and the version's automation executions. */
export function useModelVersionDetail(projectId: string, versionId: string) {
  const detail = useQuery(`${projectId}:model-version:${versionId}`, (signal) =>
    registryApi.modelVersionDetail(projectId, versionId, signal),
  );
  const sourceRunId = detail.value?.version.sourceRunId ?? null;
  const sourceRun = useQueryPolledWhileActive<Run>(
    sourceRunId ? `${projectId}:run:${sourceRunId}` : null,
    (signal) => trackingApi.run(projectId, sourceRunId!, signal),
    (run) => hasActiveRun([run]),
  );
  const rules = useQuery(`${projectId}:automation-rules`, (signal) =>
    automationApi.rules(projectId, signal),
  );
  const executions = useQueryPolledWhileActive(
    `${projectId}:model-version:${versionId}:executions`,
    (signal) => automationApi.versionExecutions(projectId, versionId, signal),
    (page) => hasActiveExecution(page.items),
  );
  return { detail, sourceRun, rules, executions };
}
