// Run list, server-side Run search, and its paging. native-run-search owns the entries.
// Chart panels on the Run pages, system metrics and resumed segments: chart-panels-and-pages-web.
export const runsText = {
  queryHint: "名前、または metrics.loss < 0.1 AND params.batch_size = '32'",
  filterEmpty: '検索式を入力してください。',
  firstPage: '最初のページ',
  mediaTab: 'Media',
  analysisTab: 'Analysis',
  charts: '図',
  showCharts: '図を表示',
  hideCharts: '図を隠す',
  addChart: '図を追加',
  resetChartLayout: '既定の配置に戻す',
  noChartPanels: '図がありません。「図を追加」から作成します。',
  noChartMetrics: '図にできるメトリクスがまだありません。',
  chartNoRuns: '図にするRunがありません。一覧でRunを選んでください。',
  editChart: '図を設定',
  removeChart: '図を削除',
  moveChartUp: '上へ移動',
  moveChartDown: '下へ移動',
  moveChartLeft: '左へ移動',
  moveChartRight: '右へ移動',
  chartWidthThird: '幅 1/3',
  chartWidthHalf: '幅 1/2',
  chartWidthFull: '全幅',
  chartHeightTall: '高くする',
  chartLayoutActions: '配置',
  chartPanelTitle: 'タイトル',
  chartPanelTitleHint: '空欄ならメトリクス名を表示します',
  chartMetricKeys: '表示するメトリクス',
  chartMetricKeySearch: 'メトリクスを検索',
  chartMetricKeysRequired: 'メトリクスを1つ以上選んでください。',
  chartMetricKeyNoMatch: '一致するメトリクスはありません。',
  chartGrouping: 'グループ化',
  chartGroupingNone: 'しない',
  chartGroupingTag: 'Tag',
  chartGroupingParam: 'Param',
  chartGroupingExperiment: 'Experiment',
  chartGroupingKey: 'グループ化するキー',
  chartTarget: '図にするRun',
  chartGroupingAppliesToAll: 'すべての図で、グループごとの平均と範囲を描きます。',
  systemMetricsEmpty: 'システムメトリクスはまだありません。',
  resumeTimeline: '実行区間',
  resumeSegmentRunning: '実行中',
  resumeSegmentStart: '開始',
  resumeSegmentEnd: '終了',
  resumeSegmentFirstStep: '最初のstep',
  resumeSegmentEndStatus: '終了状態',
} as const;

/** Panel titles of the system metrics tab, by category. */
export const systemMetricCategoryLabels = {
  cpu: 'CPU',
  memory: 'メモリ',
  disk: 'ディスク',
  network: 'ネットワーク',
  gpu: 'GPU',
  other: 'その他',
} as const;

/** Units of the system metrics panels. MLflow megabytes are drawn in bytes. */
export const systemMetricUnitLabels = {
  percent: '%',
  bytes: 'bytes',
  bytes_per_second: 'bytes/秒',
  bytes_total: '開始からの累計 bytes',
  load: 'load average',
  celsius: '℃',
  watts: 'W',
  value: '値',
} as const;

// Text that embeds values; merged into catalog's textTemplates.
export const runsTextTemplates = {
  filterUnexpectedAt: (position: number) =>
    `検索式の${position}文字目を確認してください。metrics / params / tags などの比較をANDでつなげ、文字列は引用符で囲みます（例: metrics.loss < 0.1 AND params.lr = '0.01'）。`,
  metricAscending: (name: string) => `${name}（昇順）`,
  metricDescending: (name: string) => `${name}（降順）`,
  pageNumber: (page: number) => `${page}ページ目`,
  chartMetricKeysSelected: (count: number, limit: number) => `${count} / ${limit} 件を選択`,
  chartTopRuns: (count: number) => `検索結果の上位 ${count} 件`,
  chartSelectedRuns: (count: number) => `選択した ${count} 件`,
  systemMetricPanelTitle: (category: string, unit: string, gpuIndex: number | null) =>
    gpuIndex === null ? `${category}（${unit}）` : `${category} ${gpuIndex}（${unit}）`,
  resumeSegmentLabel: (index: number) => (index === 0 ? '最初の実行' : `再開 ${index}`),
};
