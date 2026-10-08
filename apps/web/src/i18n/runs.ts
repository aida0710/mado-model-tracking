// Run list, server-side Run search, and its paging. native-run-search owns the entries.
export const runsText = {
  queryHint: "名前、または metrics.loss < 0.1 AND params.batch_size = '32'",
  filterEmpty: '検索式を入力してください。',
  firstPage: '最初のページ',
} as const;

// Text that embeds values; merged into catalog's textTemplates.
export const runsTextTemplates = {
  filterUnexpectedAt: (position: number) =>
    `検索式の${position}文字目を確認してください。metrics / params / tags などの比較をANDでつなげ、文字列は引用符で囲みます（例: metrics.loss < 0.1 AND params.lr = '0.01'）。`,
  metricAscending: (name: string) => `${name}（昇順）`,
  metricDescending: (name: string) => `${name}（降順）`,
  pageNumber: (page: number) => `${page}ページ目`,
};
