import { describe, expect, it } from 'vitest';
import type { ModelAutomationExecution } from '@mmt/contracts';
import { automationRuleStage, groupAutomationPipelines } from './automationPipelines';

function execution(
  overrides: Partial<ModelAutomationExecution> & Pick<ModelAutomationExecution, 'id' | 'ruleId'>,
): ModelAutomationExecution {
  return {
    projectId: 'project',
    modelVersionId: 'version',
    runId: null,
    jobId: null,
    status: 'queued',
    sourceRunId: null,
    runStatus: null,
    jobStatus: null,
    error: null,
    triggerRunId: null,
    pipelineRootExecutionId: overrides.id,
    attempt: 1,
    source: 'automatic',
    createdAt: '2026-10-08T00:00:00Z',
    ...overrides,
  };
}

const rules = [
  { id: 'infer', upstreamRuleId: null },
  { id: 'evaluate', upstreamRuleId: 'infer' },
  { id: 'report', upstreamRuleId: 'evaluate' },
];

describe('自動実行履歴のpipelineごとのまとめ方', () => {
  it('上流ruleを辿った数で段を数える', () => {
    const rulesById = new Map(rules.map((rule) => [rule.id, rule]));
    expect(automationRuleStage('infer', rulesById)).toBe(1);
    expect(automationRuleStage('report', rulesById)).toBe(3);
    expect(automationRuleStage('deleted-rule', rulesById)).toBe(1);
  });
  it('循環したrule一覧でも段の数え上げが終わる', () => {
    const cyclic = new Map([
      ['a', { upstreamRuleId: 'b' }],
      ['b', { upstreamRuleId: 'a' }],
    ]);
    expect(automationRuleStage('a', cyclic)).toBeLessThanOrEqual(10);
  });
  it('同じpipelineの段を上流から順に並べ、新しく動いたpipelineを先にする', () => {
    const rows = groupAutomationPipelines(
      [
        execution({
          id: 'old-evaluate',
          ruleId: 'evaluate',
          pipelineRootExecutionId: 'old-infer',
          createdAt: '2026-10-08T01:10:00Z',
        }),
        execution({ id: 'new-infer', ruleId: 'infer', createdAt: '2026-10-08T02:00:00Z' }),
        execution({ id: 'old-infer', ruleId: 'infer', createdAt: '2026-10-08T01:00:00Z' }),
        execution({
          id: 'old-report',
          ruleId: 'report',
          pipelineRootExecutionId: 'old-infer',
          createdAt: '2026-10-08T03:00:00Z',
        }),
      ],
      rules,
    );
    expect(rows.map((row) => [row.execution.id, row.stage, row.isPipelineStart])).toEqual([
      ['old-infer', 1, true],
      ['old-evaluate', 2, false],
      ['old-report', 3, false],
      ['new-infer', 1, true],
    ]);
  });
  it('同じ段の手動適用は元の実行の後に並ぶ', () => {
    const rows = groupAutomationPipelines(
      [
        execution({
          id: 'manual',
          ruleId: 'evaluate',
          pipelineRootExecutionId: 'root',
          source: 'manual',
          attempt: 2,
          createdAt: '2026-10-08T05:00:00Z',
        }),
        execution({
          id: 'first',
          ruleId: 'evaluate',
          pipelineRootExecutionId: 'root',
          createdAt: '2026-10-08T04:00:00Z',
        }),
      ],
      rules,
    );
    expect(rows.map((row) => row.execution.id)).toEqual(['first', 'manual']);
    expect(rows[0]?.isPipelineStart).toBe(true);
  });
  it('rootが無い保留中の行はそれぞれ別のpipelineとして扱う', () => {
    const rows = groupAutomationPipelines(
      [
        execution({ id: 'a', ruleId: 'infer', status: 'pending', pipelineRootExecutionId: null }),
        execution({ id: 'b', ruleId: 'infer', status: 'pending', pipelineRootExecutionId: null }),
      ],
      rules,
    );
    expect(rows.every((row) => row.isPipelineStart)).toBe(true);
  });
});
