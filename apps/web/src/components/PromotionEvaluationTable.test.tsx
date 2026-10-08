import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { PROMOTION_FIRST_RELEASE_REASON, type PromotionEvaluation } from '@mmt/contracts';
import { PromotionEvaluationTable } from './PromotionEvaluationTable';
import {
  promotionCriterionReasonLabels,
  promotionDecisionLabels,
  promotionTextTemplates,
} from '../i18n/promotion';
import { text } from '../i18n/catalog';

const passed: PromotionEvaluation = {
  id: 'evaluation-1',
  projectId: 'project',
  policyId: 'policy',
  modelId: 'model',
  candidateVersionId: 'version-2',
  candidateRunId: 'run-candidate-0001',
  baselineVersionId: 'version-1',
  baselineRunId: 'run-baseline-0001',
  decision: 'passed',
  criteriaResults: [
    {
      metric: 'wer',
      direction: 'lower',
      mode: 'delta',
      threshold: -0.01,
      candidate: 0.1,
      baseline: 0.12,
      candidateStatus: 'present',
      baselineStatus: 'present',
      observed: -0.02,
      outcome: 'passed',
      reason: null,
    },
  ],
  reason: null,
  promoted: false,
  aliasEventId: null,
  sequence: 1,
  requestedBy: null,
  createdAt: '2026-10-08T00:00:00.000Z',
};
const versionLabels: Record<string, string> = { 'version-1': '1', 'version-2': '2' };

function render(
  evaluations: PromotionEvaluation[],
  { canReevaluate = false }: { canReevaluate?: boolean } = {},
) {
  return renderToStaticMarkup(
    <MemoryRouter>
      <PromotionEvaluationTable
        evaluations={evaluations}
        projectId="project"
        versionLabel={(id) => versionLabels[id] ?? id}
        canReevaluate={canReevaluate}
        reevaluating={false}
        onReevaluate={() => undefined}
        empty={text.promotionEvaluationsEmpty}
      />
    </MemoryRouter>,
  );
}

describe('判定履歴の表示', () => {
  it('合格の判定に、基準ごとの値と閾値、候補版・基準版・評価Runへのリンクを表示する', () => {
    const html = render([passed]);
    expect(html).toContain(promotionDecisionLabels.passed);
    expect(html).toContain('werの基準との差 ≤ -0.01');
    expect(html).toContain('-0.02');
    expect(html).toContain(text.promotionCriterionPassed);
    expect(html).toContain('href="/projects/project/models?version=version-2"');
    expect(html).toContain('href="/projects/project/models?version=version-1"');
    expect(html).toContain('href="/projects/project/runs/run-candidate-0001"');
    expect(html).toContain('href="/projects/project/runs/run-baseline-0001"');
    expect(html).not.toContain(text.promotionFirstRelease);
  });

  it('基準aliasが未設定で合格した初回には印を付け、基準版とRunは空欄にする', () => {
    const html = render([
      {
        ...passed,
        baselineVersionId: null,
        baselineRunId: null,
        reason: PROMOTION_FIRST_RELEASE_REASON,
        criteriaResults: [],
      },
    ]);
    expect(html).toContain(text.promotionFirstRelease);
    expect(html).not.toContain('models?version=version-1');
    expect(html).not.toContain('/runs/run-baseline');
  });

  it('判定できない基準は「判定できない」と理由を表示する', () => {
    const html = render([
      {
        ...passed,
        decision: 'failed',
        criteriaResults: [
          {
            ...passed.criteriaResults[0]!,
            candidate: null,
            candidateStatus: 'missing',
            observed: null,
            outcome: 'insufficient',
            reason: 'candidate_metric_missing',
          },
        ],
      },
    ]);
    expect(html).toContain(promotionDecisionLabels.failed);
    expect(html).toContain(text.promotionCriterionInsufficient);
    expect(html).toContain(promotionCriterionReasonLabels.candidate_metric_missing);
    expect(html).not.toContain('candidate_metric_missing');
  });

  it('基準版なしで合格した基準は、緑の「満たす」ではなく比較なしと理由を日本語で表示する', () => {
    const html = render([
      {
        ...passed,
        baselineVersionId: null,
        baselineRunId: null,
        reason: PROMOTION_FIRST_RELEASE_REASON,
        criteriaResults: [
          {
            ...passed.criteriaResults[0]!,
            baseline: null,
            baselineStatus: 'missing',
            observed: null,
            outcome: 'passed',
            reason: 'baseline_missing',
          },
        ],
      },
    ]);
    expect(html).toContain(text.promotionCriterionNotCompared);
    expect(html).not.toContain(text.promotionCriterionPassed);
    expect(html).toContain(promotionCriterionReasonLabels.baseline_missing);
    expect(html).not.toContain('baseline_missing');
  });

  it('再判定の行は何回目かを表示する', () => {
    const html = render([{ ...passed, id: 'evaluation-2', sequence: 3 }]);
    expect(html).toContain(promotionTextTemplates.reevaluationSequence(3));
  });

  it('再判定ボタンはProject adminのときだけ表示する', () => {
    expect(render([passed])).not.toContain(text.promotionReevaluate);
    expect(render([passed], { canReevaluate: true })).toContain(text.promotionReevaluate);
  });

  it('判定が無ければ空の案内を表示する', () => {
    expect(render([])).toContain(text.promotionEvaluationsEmpty);
  });
});
