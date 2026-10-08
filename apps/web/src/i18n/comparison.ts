// Run comparison page and CSV exports. run-comparison-csv-export owns the entries.
export const comparisonText = {
  comparisonBaselineRun: '基準Run',
  comparisonNoBaseline: 'なし',
  comparisonBaselineMarker: '基準',
  comparisonOnlyDifferences: '差のある行だけ',
  comparisonDownloadCsv: 'CSVをダウンロード',
  comparisonModelVersion: 'モデル版',
  comparisonDatasetVersions: '評価データセット版',
  comparisonNoDifferences: '選んだRunの間に差のある行はありません',
  exportRunsCsv: '検索結果をCSV出力',
  exportingRunsCsv: 'CSVを作成しています…',
  exportRunsTruncated:
    '一致したRunが出力の上限を超えたため、途中で打ち切りました。CSVの末尾にも記載しています。',
} as const;

// Text that embeds values; merged into catalog's textTemplates.
export const comparisonTextTemplates = {
  comparisonRunCountOutOfRange: (minimum: number, maximum: number) =>
    `比較するRunを${minimum}〜${maximum}件選んでください。`,
};
