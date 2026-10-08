import type { ModelAutomationExecution, ModelAutomationRule } from '@mmt/contracts';

// The API caps chains at MAX_AUTOMATION_CHAIN_DEPTH=5. The Web stops a little later so a rule list
// that is out of date (or a broken cycle) still ends instead of looping.
const MAX_DISPLAYED_STAGE = 10;

export interface AutomationPipelineRow {
  execution: ModelAutomationExecution;
  // 1 for the rule that reacts to model registration, +1 for each upstream rule hop.
  stage: number;
  isPipelineStart: boolean;
}

/** Counts upstream hops, so a stage keeps its position even when earlier rows fell off the list. */
export function automationRuleStage(
  ruleId: string,
  rulesById: ReadonlyMap<string, Pick<ModelAutomationRule, 'upstreamRuleId'>>,
): number {
  let stage = 1;
  let upstreamRuleId = rulesById.get(ruleId)?.upstreamRuleId ?? null;
  while (upstreamRuleId && stage < MAX_DISPLAYED_STAGE) {
    stage += 1;
    upstreamRuleId = rulesById.get(upstreamRuleId)?.upstreamRuleId ?? null;
  }
  return stage;
}

function pipelineKey(execution: ModelAutomationExecution): string {
  return execution.pipelineRootExecutionId ?? execution.id;
}

/**
 * Orders executions so each pipeline reads top to bottom: pipelines with the newest activity
 * first, and within one pipeline by stage, then by creation time (so retries follow the original).
 */
export function groupAutomationPipelines(
  executions: ModelAutomationExecution[],
  rules: Pick<ModelAutomationRule, 'id' | 'upstreamRuleId'>[],
): AutomationPipelineRow[] {
  const rulesById = new Map(rules.map((rule) => [rule.id, rule]));
  const pipelines = new Map<string, ModelAutomationExecution[]>();
  for (const execution of executions) {
    const key = pipelineKey(execution);
    pipelines.set(key, [...(pipelines.get(key) ?? []), execution]);
  }
  const latestCreatedAt = (members: ModelAutomationExecution[]) =>
    members.reduce((latest, item) => (item.createdAt > latest ? item.createdAt : latest), '');
  return [...pipelines.values()]
    .sort((left, right) => latestCreatedAt(right).localeCompare(latestCreatedAt(left)))
    .flatMap((members) =>
      members
        .map((execution) => ({
          execution,
          stage: automationRuleStage(execution.ruleId, rulesById),
        }))
        .sort(
          (left, right) =>
            left.stage - right.stage ||
            left.execution.createdAt.localeCompare(right.execution.createdAt),
        )
        .map((row, index) => ({ ...row, isPipelineStart: index === 0 })),
    );
}
