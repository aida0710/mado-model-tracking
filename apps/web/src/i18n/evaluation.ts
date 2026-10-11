// Evaluation comparison panel. evaluation-baseline-comparison owns the entries.
export const evaluationText = {
  evaluationComparison: '基準バージョンとの評価比較',
  baselineAlias: '基準alias',
  baselineVersion: '基準バージョン',
  noModelAliases: 'aliasが未設定です',
  comparisonBaselineMissing: '基準aliasが設定されていないため比較できません。',
  comparisonBaselineNotEvaluated:
    '基準バージョンに、同じ正解セットと評価コードバージョンで完了した評価Runがありません。',
  comparisonCandidateNotEvaluated: 'このバージョンの完了した評価Runがありません。',
  comparisonConditions: '比較条件',
  referenceDatasets: '正解セット',
  noReferenceDatasets: 'なし',
  evaluationCodeVersion: '評価コードバージョン',
  evaluationRule: '評価ルール',
  candidateEvaluationRun: '候補の評価Run',
  baselineEvaluationRun: '基準の評価Run',
  metricCandidate: '候補',
  metricBaseline: '基準',
  metricDelta: '差',
  metricRelativeDelta: '相対差',
  metricSource: '値の出典',
  metricSourceDatasetContext: '正解セットで記録した値',
  metricSourceRunLatest: 'Runの最新値',
  metricNotFinite: 'NaN/∞',
  noComparedMetrics: '比較できるメトリクスがありません',
  baselineChoice: '基準にするバージョン',
  baselineChoiceAliasGroup: 'aliasで選ぶ',
  baselineChoiceVersionGroup: 'バージョンを直接選ぶ',
  baselineIsCandidate: '基準がこのバージョン自身なので、差はすべて0になります。別のバージョンを選んでください。',
} as const;

export const evaluationTextTemplates = {
  versionLabel: (version: string) => `バージョン ${version}`,
  baselineAliasOption: (alias: string, versionLabel: string) => `${alias}（${versionLabel}）`,
  baselineFallbackHint: (alias: string) =>
    `${alias} はこのバージョンを指しているため、直前に登録されたバージョンを基準にしています。`,
};
