// Metric chart, its controls, legend and tooltip. metrics-chart-core-web owns the entries.
export const chartsText = {
  chartNoData: '表示できる値がありません',
  chartSmoothing: '平滑化',
  chartSmoothingNone: 'なし',
  chartSmoothingEma: 'EMA（指数移動平均）',
  chartSmoothingGaussian: 'ガウス',
  chartSmoothingRunningAverage: '移動平均',
  chartSmoothingWeight: '平滑化の強さ',
  chartXAxis: 'x軸',
  chartXAxisStep: 'Step',
  chartXAxisRelativeTime: '経過時間',
  chartXAxisWallTime: '時刻',
  chartXAxisMetric: 'メトリクス',
  chartXAxisMetricKey: 'x軸のメトリクス',
  chartLogX: 'x軸を対数',
  chartLogY: 'y軸を対数',
  chartShowRange: '範囲（最小〜最大）を表示',
  chartShowRaw: '平滑化前の線を表示',
  chartLegend: '凡例',
  chartShowAllSeries: 'すべて表示',
  chartResetZoom: 'ズームを戻す',
  chartZoomHint: 'ドラッグした範囲を拡大します',
  chartResumeMarker: '再開',
  chartGroupSuffix: '（平均）',
} as const;

// Text that embeds values; merged into catalog's textTemplates.
export const chartsTextTemplates = {
  chartLogExcluded: (count: number) =>
    `対数軸に置けない0以下の値 ${count} 点を描いていません。`,
  chartTooltipMore: (count: number) => `ほか ${count} 件`,
  chartAriaLabel: (seriesCount: number) => `メトリクスの図（${seriesCount} 系列）`,
  chartResumeMarkerOf: (runLabel: string) => `${runLabel} を再開`,
};
