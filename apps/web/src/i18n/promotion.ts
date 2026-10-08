import type {
  PromotionCriterionDirection,
  PromotionCriterionMode,
  PromotionDecision,
  PromotionMissingBaseline,
} from '@mmt/contracts';
import type { CriterionThresholdMeaning } from '../lib/promotionPolicyInput';

// Promotion policies (pass/fail criteria for a candidate version) and their evaluation history.
// Labels shared with the evaluation comparison (baselineAlias, evaluationRule, referenceDatasets,
// evaluationCodeVersion, baselineVersion) come from i18n/evaluation.ts.
export const promotionText = {
  promotionPolicies: '昇格policy',
  newPromotionPolicy: '昇格policyを作成',
  promotionPoliciesEmpty: '昇格policyはまだありません',
  promotionModel: '対象モデル',
  promotionTargetAlias: '対象alias',
  promotionEvaluationRuleHint:
    '対象モデルの系列を扱える、有効な評価（Evaluation）の自動実行ルールから選びます。判定には、このルールが作った評価Runだけを使います。',
  promotionEvaluationRulesEmpty:
    'このモデルを対象にできる有効な評価ルールがありません。先に「自動実行ルール」で評価ルールを作成してください。',
  promotionEvaluationConditions: '評価条件（評価ルールの設定）',
  promotionCriteria: '合否基準',
  promotionCriteriaHint: 'すべての基準を満たしたときに合格になります。',
  promotionCriterionMetric: 'メトリクス',
  promotionCriterionDirection: '良い方向',
  promotionCriterionMode: '比べる値',
  promotionCriterionThreshold: '閾値',
  promotionRelativeDeltaHint: '相対差は比率で入力します（0.05 = 5%）。',
  promotionAddCriterion: '基準を追加',
  promotionRemoveCriterion: '基準を削除',
  promotionMissingBaseline: '基準aliasが未設定のとき',
  promotionAutoPromote: '合格したら対象aliasを自動で切り替える',
  promotionAutoPromoteColumn: '自動昇格',
  promotionAutoPromoteOn: 'する',
  promotionAutoPromoteOff: 'しない',
  promotionPolicyEnabled: '作成後すぐに有効にする',
  promotionPolicyFixedSettings:
    '作成後は有効・無効のみ変更できます。設定を変える場合は新しいpolicyを作成してください。',
  promotionEvaluations: '判定履歴',
  promotionEvaluationsEmpty: 'このpolicyの判定はまだありません',
  promotionEvaluatedAt: '日時',
  promotionDecision: '判定',
  promotionCandidateVersion: '候補版',
  promotionEvaluationRuns: '評価Run',
  promotionCriterionResults: '基準ごとの結果',
  promotionCriterionPassed: '満たす',
  promotionCriterionFailed: '満たさない',
  promotionFirstRelease: '初回合格（基準なし）',
  promotionReevaluate: '再判定',
  promotionLoadMore: 'さらに読み込む',
  // Client-side validation of the create form.
  promotionPolicyNameRequired: '名前を入力してください。',
  promotionModelRequired: 'このプロジェクトのモデルを選択してください。',
  promotionTargetAliasRequired: '対象aliasを入力してください。',
  promotionBaselineAliasRequired: '基準aliasを入力してください。',
  promotionEvaluationRuleRequired: '対象モデルを扱える有効な評価ルールを選択してください。',
  promotionCriteriaRequired: '合否基準を1つ以上追加してください。',
  promotionCriterionMetricRequired: '合否基準のメトリクス名を入力してください。',
  promotionCriterionThresholdInvalid: '合否基準の閾値は有限の数値で入力してください。',
} as const;

export const promotionDecisionLabels: Record<PromotionDecision, string> = {
  passed: '合格',
  failed: '不合格',
  insufficient: '判定不能',
  skipped: '判定せず',
};

export const promotionDirectionLabels: Record<PromotionCriterionDirection, string> = {
  higher: '大きいほど良い',
  lower: '小さいほど良い',
};

export const promotionModeLabels: Record<PromotionCriterionMode, string> = {
  absolute: '候補の値',
  delta: '基準との差',
  relative_delta: '基準との相対差',
};

export const promotionMissingBaselineLabels: Record<PromotionMissingBaseline, string> = {
  pass: '合格にする（初回の登録）',
  fail: '不合格にする',
};

export const criterionThresholdMeaningLabels: Record<CriterionThresholdMeaning, string> = {
  improvement_required: '改善が必要',
  no_regression: '悪化しなければよい',
  regression_allowed: 'この幅までの悪化を許容',
};

// Text that embeds values.
export const promotionTextTemplates = {
  criteriaTooMany: (max: number) => `合否基準は${max}件までです。`,
  criterionSubject: (metric: string, mode: PromotionCriterionMode) =>
    mode === 'absolute' ? metric : `${metric}の${promotionModeLabels[mode]}`,
  ruleOption: (ruleName: string, codeVersion: string) => `${ruleName}（${codeVersion}）`,
  reevaluationSequence: (sequence: number) => `再判定 ${sequence - 1}回目`,
};
