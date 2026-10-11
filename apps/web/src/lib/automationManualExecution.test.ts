import { describe, expect, it } from 'vitest';
import type { ModelAutomationExecution, ModelAutomationRule, ModelVersion } from '@mmt/contracts';
import { executionCatalog } from '../../tests/fixtures/execution';
import { RequestError } from '../api/http';
import {
  manualExecutionErrorMessage,
  manualExecutionRequest,
  manualUpstreamRunOptions,
  manualVersionOptions,
} from './automationManualExecution';
import { automationText } from '../i18n/automation';

const version = (id: string, family: string): ModelVersion => ({
  id,
  modelId: 'model',
  projectId: 'project',
  version: id,
  family,
  sourceRunId: null,
  parentModelVersionIds: [],
  weightsUri: 'artifact://weights',
  artifactId: null,
  defaultCodeVersionId: null,
  metadata: {},
  createdAt: '2026-10-08T00:00:00Z',
});
type RuleTrigger = Pick<ModelAutomationRule, 'trigger' | 'upstreamRuleId' | 'modelFamilies'>;
const registered: RuleTrigger = {
  trigger: 'model_registered',
  upstreamRuleId: null,
  modelFamilies: ['Qwen3'],
};
const chained: RuleTrigger = {
  trigger: 'upstream_run_finished',
  upstreamRuleId: 'infer',
  modelFamilies: ['Qwen3'],
};

function execution(overrides: Partial<ModelAutomationExecution>): ModelAutomationExecution {
  return {
    id: 'execution',
    projectId: 'project',
    ruleId: 'infer',
    modelVersionId: 'v1',
    runId: 'run-1',
    jobId: 'job-1',
    status: 'queued',
    sourceRunId: null,
    runStatus: 'finished',
    jobStatus: 'finished',
    error: null,
    triggerRunId: null,
    pipelineRootExecutionId: 'execution',
    attempt: 1,
    source: 'automatic',
    requestedBy: null,
    retryOfExecutionId: null,
    createdAt: '2026-10-08T00:00:00Z',
    ...overrides,
  };
}

describe('既存のバージョンへの手動適用', () => {
  it('バージョンの候補はruleの対象モデル系列のバージョンだけにする', () => {
    const registry = {
      ...executionCatalog,
      modelVersions: [version('v1', 'Qwen3'), version('v2', 'Llama')],
    };
    expect(manualVersionOptions(registered, registry).map((option) => option.value)).toEqual([
      'v1',
    ]);
  });
  it('上流Runの候補は上流ruleが作って成功したRunだけにし、同じRunを重ねない', () => {
    const options = manualUpstreamRunOptions({
      rule: chained,
      executions: [
        execution({ id: 'a', runId: 'run-1' }),
        execution({ id: 'b', runId: 'run-1', source: 'manual', attempt: 2 }),
        execution({ id: 'c', runId: 'run-failed', runStatus: 'failed' }),
        execution({ id: 'd', runId: 'run-other', ruleId: 'another-rule' }),
        execution({ id: 'e', runId: null, status: 'skipped', runStatus: null }),
      ],
      versionLabel: (id) => `Qwen / ${id}`,
    });
    expect(options.map((option) => option.value)).toEqual(['run-1']);
    expect(options[0]?.label).toContain('Qwen / v1');
  });
  it('トリガーに合わせてバージョンまたは上流Runを送る', () => {
    expect(manualExecutionRequest(registered, 'v1')).toEqual({ modelVersionId: 'v1' });
    expect(manualExecutionRequest(chained, 'run-1')).toEqual({ triggerRunId: 'run-1' });
  });
  it('実行中の409と無効ruleの422をそれぞれの理由で表示する', () => {
    expect(manualExecutionErrorMessage(new RequestError({ status: 409, code: 'conflict' }))).toBe(
      automationText.applyRunning,
    );
    expect(
      manualExecutionErrorMessage(
        new RequestError({
          status: 422,
          code: 'invalid_request',
          serverMessage: 'Rule is disabled',
        }),
      ),
    ).toBe('Rule is disabled');
    expect(manualExecutionErrorMessage(new RequestError({ status: 422 }))).toBe(
      automationText.applyInvalidRule,
    );
  });
});
