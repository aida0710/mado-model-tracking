import { describe, expect, it } from 'vitest';
import { canRerunExecution, rerunRequest } from './automationRerun';

const registrationRule = {
  enabled: true,
  trigger: 'model_registered' as const,
  upstreamRuleId: null,
  modelFamilies: ['Qwen3'],
};
const chainedRule = {
  ...registrationRule,
  trigger: 'upstream_run_finished' as const,
  upstreamRuleId: 'infer',
};
const failedExecution = {
  status: 'queued' as const,
  runStatus: 'failed' as const,
  jobStatus: 'failed' as const,
  modelVersionId: 'v1',
  triggerRunId: null,
};

describe('自動実行の再実行', () => {
  it('終わった実行は同じ版へ再実行でき、登録起動のruleは版を指定する', () => {
    expect(canRerunExecution(failedExecution, registrationRule)).toBe(true);
    expect(rerunRequest(failedExecution, registrationRule)).toEqual({ modelVersionId: 'v1' });
  });

  it('実行中・学習完了待ち・無効なrule・ruleが不明な行は再実行できない', () => {
    expect(
      canRerunExecution(
        { ...failedExecution, runStatus: 'running', jobStatus: 'running' },
        registrationRule,
      ),
    ).toBe(false);
    expect(canRerunExecution({ ...failedExecution, status: 'pending' }, registrationRule)).toBe(
      false,
    );
    expect(canRerunExecution(failedExecution, { ...registrationRule, enabled: false })).toBe(false);
    expect(canRerunExecution(failedExecution, undefined)).toBe(false);
  });

  it('連鎖のruleは起動元の上流Runを指定し、上流Runが無い行は再実行できない', () => {
    const chained = { ...failedExecution, triggerRunId: 'upstream-run' };
    expect(canRerunExecution(chained, chainedRule)).toBe(true);
    expect(rerunRequest(chained, chainedRule)).toEqual({ triggerRunId: 'upstream-run' });
    expect(canRerunExecution(failedExecution, chainedRule)).toBe(false);
  });
});
