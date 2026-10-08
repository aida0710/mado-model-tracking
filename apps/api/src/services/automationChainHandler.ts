import type { Run } from '@mmt/contracts';
import type { Connection } from '../db/database.js';
import { findExecutionForRun } from '../repositories/automationExecutionLookup.js';
import {
  hasExecutionForTriggerRun,
  insertAutomationExecution,
  lockAutomationRule,
  lockDownstreamRules,
} from '../repositories/modelAutomationRepository.js';
import { findModelVersion } from '../repositories/registryRepository.js';
import type { ModelAutomationService } from './modelAutomationService.js';
import type { RunCompletionHandler, RunStatusChange } from './runCompletionService.js';

// Why a downstream rule did not start; the codes before ':' are part of the API contract.
const UPSTREAM_SKIP_ERRORS = {
  unsuccessful: 'upstream_unsuccessful: 上流Runが成功しなかったため起動しません',
  outputsMissing: 'upstream_outputs_missing: 上流Runに出力DatasetVersionがないため起動しません',
} as const;

function upstreamSkipError(run: Pick<Run, 'status' | 'outputDatasetVersionIds'>): string | null {
  if (run.status !== 'finished') return UPSTREAM_SKIP_ERRORS.unsuccessful;
  if (run.outputDatasetVersionIds.length === 0) return UPSTREAM_SKIP_ERRORS.outputsMissing;
  return null;
}

/**
 * Starts the rules chained after the rule that created a terminal Run. The upstream rule is found
 * through model_automation_executions (following manual Job retries), never through Run tags, so
 * Runs people created do not start a chain. Each (downstream rule, upstream Run) pair is handled
 * once, which keeps repeated completions and MLflow reopen/finish cycles from duplicating stages.
 */
export class AutomationChainHandler implements RunCompletionHandler {
  readonly name = 'automation-chain';

  constructor(private readonly automation: ModelAutomationService) {}

  async handle(connection: Connection, change: RunStatusChange): Promise<void> {
    const { run } = change;
    const upstream = await findExecutionForRun(connection, {
      projectId: run.projectId,
      runId: run.id,
    });
    if (!upstream) return;
    const upstreamRule = await lockAutomationRule(connection, {
      projectId: run.projectId,
      id: upstream.ruleId,
      mode: 'share',
    });
    // A disabled upstream rule stops its pipeline, including Runs it started before.
    if (!upstreamRule?.enabled) return;
    const model = await findModelVersion(connection, {
      projectId: run.projectId,
      id: upstream.modelVersionId,
    });
    const rules = await lockDownstreamRules(connection, {
      projectId: run.projectId,
      ruleId: upstream.ruleId,
      family: model.family,
    });
    for (const rule of rules) {
      if (await hasExecutionForTriggerRun(connection, { ruleId: rule.id, triggerRunId: run.id }))
        continue;
      const skipError = upstreamSkipError(run);
      if (skipError) {
        await insertAutomationExecution(connection, {
          projectId: run.projectId,
          ruleId: rule.id,
          modelVersionId: model.id,
          status: 'skipped',
          error: skipError,
          triggerRunId: run.id,
          pipelineRootExecutionId: upstream.pipelineRootExecutionId,
        });
        continue;
      }
      await this.automation.executeRule(connection, {
        rule,
        model,
        trigger: {
          run,
          pipelineRootExecutionId: upstream.pipelineRootExecutionId,
          source: 'automatic',
          attempt: 1,
          requestedBy: null,
        },
      });
    }
  }
}
