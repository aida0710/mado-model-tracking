import { describe, expect, it } from 'vitest';
import { PROMOTION_CRITERIA_MAX, type ModelAutomationRule } from '@mmt/contracts';
import { executionCatalog } from '../../tests/fixtures/execution';
import {
  buildPromotionPolicyInput,
  createCriterionDraft,
  createPromotionPolicyDraft,
  getCriterionThresholdMeaning,
  parseCriterionThreshold,
  summarizeCriterion,
  updatePromotionPolicyDraft,
  type PromotionPolicyDraft,
} from './promotionPolicyInput';
import { promotionTextTemplates } from '../i18n/promotion';
import { canManagePromotionPolicies, canReevaluatePromotion } from './permissions';
import { text } from '../i18n/catalog';

const models = executionCatalog.models;
const evaluationRule: ModelAutomationRule = {
  id: 'rule-eval',
  projectId: 'project',
  name: 'WER evaluation',
  enabled: true,
  modelFamilies: ['Qwen3'],
  kind: 'evaluation',
  trigger: 'model_registered',
  upstreamRuleId: null,
  experimentId: 'experiment',
  codeVersionId: 'code-v1',
  targetId: 'target',
  gpuIds: [],
  inputDatasetVersionIds: ['dataset-v1'],
  parameters: {},
  tags: {},
  maxAttempts: 1,
  summaryMetrics: [],
  createdBy: 'user',
  runAsUserId: 'user',
  createdAt: '2026-10-08T00:00:00.000Z',
};
const rules: ModelAutomationRule[] = [
  evaluationRule,
  { ...evaluationRule, id: 'rule-inference', kind: 'inference' },
  { ...evaluationRule, id: 'rule-disabled', enabled: false },
  { ...evaluationRule, id: 'rule-other-family', modelFamilies: ['Whisper'] },
];

function draftWith(changes: Partial<PromotionPolicyDraft>): PromotionPolicyDraft {
  return {
    ...createPromotionPolicyDraft('model'),
    name: 'Promote WER',
    evaluationRuleId: 'rule-eval',
    criteria: [
      { ...createCriterionDraft(), metric: 'wer', direction: 'lower', threshold: '-0.01' },
    ],
    ...changes,
  };
}
const build = (draft: PromotionPolicyDraft) => buildPromotionPolicyInput({ draft, models, rules });

describe('昇格policyの入力', () => {
  it('評価ruleと合否基準を数値に変換して登録内容を作る', () => {
    expect(build(draftWith({}))).toEqual({
      name: 'Promote WER',
      enabled: true,
      modelId: 'model',
      targetAlias: 'production',
      baselineAlias: 'production',
      evaluationRuleId: 'rule-eval',
      criteria: [{ metric: 'wer', direction: 'lower', mode: 'delta', threshold: -0.01 }],
      missingBaseline: 'pass',
      autoPromote: false,
    });
  });

  it('評価ruleを選ばないと登録できない', () => {
    expect(() => build(draftWith({ evaluationRuleId: '' }))).toThrow(
      text.promotionEvaluationRuleRequired,
    );
  });

  it('推論rule・無効なrule・別系列のruleは評価ruleとして受け付けない', () => {
    for (const evaluationRuleId of ['rule-inference', 'rule-disabled', 'rule-other-family'])
      expect(() => build(draftWith({ evaluationRuleId }))).toThrow(
        text.promotionEvaluationRuleRequired,
      );
  });

  it('対象モデルを変えて評価ruleが使えなくなったら選択を外す', () => {
    const otherModel = { ...models[0]!, id: 'whisper', family: 'Whisper' };
    const next = updatePromotionPolicyDraft({
      next: draftWith({ modelId: 'whisper' }),
      models: [...models, otherModel],
      rules,
    });
    expect(next.evaluationRuleId).toBe('');
  });

  it('合否基準が空なら登録できない', () => {
    expect(() => build(draftWith({ criteria: [] }))).toThrow(text.promotionCriteriaRequired);
  });

  it('合否基準が上限を超えると登録できない', () => {
    const criteria = Array.from({ length: PROMOTION_CRITERIA_MAX + 1 }, () => ({
      ...createCriterionDraft(),
      metric: 'wer',
    }));
    expect(() => build(draftWith({ criteria }))).toThrow(
      promotionTextTemplates.criteriaTooMany(PROMOTION_CRITERIA_MAX),
    );
  });

  it('メトリクス名が空の基準は登録できない', () => {
    expect(() =>
      build(draftWith({ criteria: [{ ...createCriterionDraft(), metric: '  ' }] })),
    ).toThrow(text.promotionCriterionMetricRequired);
  });

  it('閾値は有限の数値だけを受け付け、空欄・文字・NaN・無限大を拒否する', () => {
    for (const value of ['', ' ', 'abc', 'NaN', 'Infinity', '-Infinity', '1e999'])
      expect(() => parseCriterionThreshold(value)).toThrow(text.promotionCriterionThresholdInvalid);
    expect(parseCriterionThreshold(' 0.5 ')).toBe(0.5);
    expect(parseCriterionThreshold('1e-3')).toBe(0.001);
  });

  it('閾値の符号を保ったまま登録する', () => {
    expect(parseCriterionThreshold('-0.01')).toBe(-0.01);
    expect(parseCriterionThreshold('+0.02')).toBe(0.02);
    const input = build(
      draftWith({
        criteria: [
          { ...createCriterionDraft(), metric: 'wer', direction: 'lower', threshold: '-0.01' },
          { ...createCriterionDraft(), metric: 'bleu', direction: 'higher', threshold: '-0.5' },
        ],
      }),
    );
    expect(input.criteria.map((criterion) => criterion.threshold)).toEqual([-0.01, -0.5]);
  });

  it('対象aliasと基準aliasは前後の空白を除き、空なら拒否する', () => {
    expect(build(draftWith({ targetAlias: ' champion ' })).targetAlias).toBe('champion');
    expect(() => build(draftWith({ targetAlias: ' ' }))).toThrow(text.promotionTargetAliasRequired);
    expect(() => build(draftWith({ baselineAlias: '' }))).toThrow(
      text.promotionBaselineAliasRequired,
    );
  });
});

describe('閾値の符号の意味', () => {
  it('小さいほど良いメトリクスでは、負の差が改善の要求、正の差が悪化の許容になる', () => {
    expect(
      getCriterionThresholdMeaning({ direction: 'lower', mode: 'delta', threshold: -0.01 }),
    ).toBe('improvement_required');
    expect(
      getCriterionThresholdMeaning({ direction: 'lower', mode: 'delta', threshold: 0.01 }),
    ).toBe('regression_allowed');
  });

  it('大きいほど良いメトリクスでは、正の相対差が改善の要求、負の相対差が悪化の許容になる', () => {
    expect(
      getCriterionThresholdMeaning({
        direction: 'higher',
        mode: 'relative_delta',
        threshold: 0.05,
      }),
    ).toBe('improvement_required');
    expect(
      getCriterionThresholdMeaning({
        direction: 'higher',
        mode: 'relative_delta',
        threshold: -0.05,
      }),
    ).toBe('regression_allowed');
  });

  it('差が0なら悪化しなければよく、候補の値そのものとの比較には符号の意味がない', () => {
    expect(getCriterionThresholdMeaning({ direction: 'higher', mode: 'delta', threshold: 0 })).toBe(
      'no_regression',
    );
    expect(
      getCriterionThresholdMeaning({ direction: 'lower', mode: 'absolute', threshold: -1 }),
    ).toBeNull();
  });

  it('要約は向きの比較記号と符号付きの閾値を表示し、相対差は百分率にする', () => {
    expect(
      summarizeCriterion({ metric: 'wer', direction: 'lower', mode: 'delta', threshold: -0.01 }),
    ).toBe('werの基準との差 ≤ -0.01');
    expect(
      summarizeCriterion({
        metric: 'bleu',
        direction: 'higher',
        mode: 'relative_delta',
        threshold: 0.05,
      }),
    ).toBe('bleuの基準との相対差 ≥ +5%');
    expect(
      summarizeCriterion({ metric: 'wer', direction: 'lower', mode: 'absolute', threshold: 0.2 }),
    ).toBe('wer ≤ 0.2');
  });
});

describe('昇格policyの権限', () => {
  it('policyの作成・切替はProject adminと全体管理者だけ', () => {
    expect(canManagePromotionPolicies('admin', false)).toBe(true);
    expect(canManagePromotionPolicies('viewer', true)).toBe(true);
    expect(canManagePromotionPolicies('editor', false)).toBe(false);
  });

  it('再判定はProject adminだけで、editorには許さない', () => {
    expect(canReevaluatePromotion('admin')).toBe(true);
    expect(canReevaluatePromotion('editor')).toBe(false);
    expect(canReevaluatePromotion('viewer')).toBe(false);
  });
});
