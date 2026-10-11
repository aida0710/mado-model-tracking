import type {
  ModelAliasProtectionRole,
  PromotionCriterionDirection,
  PromotionCriterionMode,
  PromotionCriterionReason,
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
  promotionCandidateVersion: '候補バージョン',
  promotionEvaluationRuns: '評価Run',
  promotionCriterionResults: '基準ごとの結果',
  promotionCriterionPassed: '満たす',
  promotionCriterionFailed: '満たさない',
  promotionCriterionInsufficient: '判定できない',
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
  // Owner (run-as user) of a policy and its transfer to a Service Account.
  promotionPolicyOwner: '実行ユーザー',
  promotionPolicyOwnerCreator: '作成者',
  promotionPolicyOwnerServiceAccount: 'Service Account',
  promotionTransferOwner: '所有者を移管',
  promotionTransferOwnerTarget: '移管先のService Account',
  promotionTransferOwnerHint:
    '作成者の記録は残ります。移管先は、このプロジェクトの有効なService Account（roleがadmin）から選びます。',
  promotionTransferOwnerNoCandidates:
    '移管できるService Accountがありません。先にプロジェクト設定でroleがadminのService Accountを作成してください。',
  promotionTransferOwnerRequired: '移管先のService Accountを選択してください。',
  // Promotion dialog (assigning an alias with its reason and evidence).
  promote: '昇格',
  promotionDialogTitle: 'aliasを設定（昇格）',
  promotionEvidence: '根拠となる判定',
  promotionEvidenceNone: '指定しない',
  promotionEvidenceChoose: '判定を選択',
  promotionEvidenceRequired: 'このaliasを変更するには、このバージョンの合格判定を選択してください。',
  promotionEvidenceEmpty: 'このバージョンには、このaliasを対象にした合格判定がありません。',
  promotionReasonRequired: '理由を入力してください。',
  promotionReasonRequiredForFailed:
    'このバージョンはこのaliasの昇格判定で不合格です。昇格させる場合は理由を入力してください。',
  promotionReasonRequiredForProtected: '保護aliasを合格判定なしで変更するには理由を入力してください。',
  promotionAliasRequired: 'aliasを入力してください。',
  promotionVersionRequired: 'バージョンを選択してください。',
  promotionProtectedAlias: '保護alias',
  // Promotion check card on the model version page.
  promotionCheck: '昇格の判定',
  promotionCheckEmpty: 'このモデルには昇格policyがありません。',
  promotionCheckPending: '判定待ち',
  promotionCheckCurrentAlias: '現在このバージョンを指しています',
  promotionCheckPromotedAutomatically: '自動昇格済み',
  promotionCheckBaselineChanged: '判定中に基準aliasが変わったため、自動昇格しませんでした。',
  promotionCheckPromotionDenied: 'aliasの変更が拒否されたため、自動昇格しませんでした。',
  // Alias protections (Models page tab).
  aliasProtections: '保護alias',
  aliasProtectionsEmpty: '保護aliasはありません。',
  aliasProtectionsHint:
    '保護aliasは、必要なrole以上の利用者だけが変更できます。合格判定を必須にすると、そのバージョンの合格判定を根拠に指定したときだけ変更できます。MLflow互換APIからは変更できません。',
  aliasProtectionAdd: '保護aliasを追加',
  aliasProtectionEdit: '保護aliasを編集',
  aliasProtectionRemove: '保護を解除',
  aliasProtectionScope: '対象',
  aliasProtectionScopeProject: 'プロジェクト全体',
  aliasProtectionRequiredRole: '変更に必要なrole',
  aliasProtectionRequirePassedEvaluation: '合格判定を必須にする',
  aliasProtectionRequirePassedEvaluationColumn: '合格判定',
  aliasProtectionRequired: '必須',
  aliasProtectionNotRequired: '不要',
  aliasProtectionUpdatedAt: '更新日時',
  promotionCriterionNotCompared: '比較なし',
  promotionCheckBaselineMoved:
    'この判定のあと、基準aliasが別のバージョンへ移りました。今の基準バージョンとは比べていないため、根拠には選んでいません。',
} as const;

export const promotionDecisionLabels: Record<PromotionDecision, string> = {
  passed: '合格',
  failed: '不合格',
  insufficient: '判定不能',
  skipped: '判定せず',
};

// Why a criterion could not compare its values (PromotionCriterionResult.reason).
export const promotionCriterionReasonLabels: Record<PromotionCriterionReason, string> = {
  candidate_metric_missing: '候補に値がありません',
  candidate_metric_not_finite: '候補の値がNaN/∞です',
  baseline_metric_missing: '基準に値がありません',
  baseline_metric_not_finite: '基準の値がNaN/∞です',
  baseline_zero: '基準が0のため相対差を計算できません',
  baseline_missing: '基準バージョンがないため比べていません',
  baseline_not_evaluated: '基準バージョンに評価がありません',
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

export const aliasProtectionRoleLabels: Record<ModelAliasProtectionRole, string> = {
  editor: 'editor以上',
  admin: 'adminのみ',
};

// Text that embeds values.
export const promotionTextTemplates = {
  protectedAliasNotice: (role: ModelAliasProtectionRole, requirePassedEvaluation: boolean) =>
    `このaliasは保護されています（${aliasProtectionRoleLabels[role]}${
      requirePassedEvaluation ? '・合格判定が必須' : ''
    }）。`,
  protectedAliasRoleMissing: (role: ModelAliasProtectionRole) =>
    `このaliasの変更には${aliasProtectionRoleLabels[role]}の権限が必要です。`,
  evidenceOption: (policyName: string, createdAt: string) => `${policyName}（${createdAt}）`,
  transferOwnerConfirm: (policyName: string) =>
    `「${policyName}」の判定と自動昇格を、選んだService Accountの権限で実行するように切り替えます。`,
  removeAliasProtectionConfirm: (alias: string, scope: string) =>
    `${scope}のalias「${alias}」の保護を解除します。解除後はeditor以上の利用者が理由なしで変更できます。`,
  criteriaTooMany: (max: number) => `合否基準は${max}件までです。`,
  criterionSubject: (metric: string, mode: PromotionCriterionMode) =>
    mode === 'absolute' ? metric : `${metric}の${promotionModeLabels[mode]}`,
  ruleOption: (ruleName: string, codeVersion: string) => `${ruleName}（${codeVersion}）`,
  reevaluationSequence: (sequence: number) => `再判定 ${sequence - 1}回目`,
  baselineMovedDetail: (judgedAgainst: string | null, current: string | null) =>
    `判定時の基準バージョン: ${judgedAgainst ?? 'なし'} / 今の基準バージョン: ${current ?? 'なし'}`,
};
