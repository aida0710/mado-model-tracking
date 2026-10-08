// Run descriptions, Markdown editing and comment threads (Run, model version and report pages).
export const commentsText = {
  markdownWrite: '編集',
  markdownPreview: 'プレビュー',
  markdownPreviewEmpty: 'プレビューする内容がありません',
  markdownHint: 'Markdownで書けます（表・チェックリスト・コードに対応）。',
  markdownUnsafeLink: 'リンク先の形式は開けないため、文字として表示しています',
  markdownExternalImage: '外部の画像は読み込まずにリンクで表示しています',
  runDescription: '説明',
  runDescriptionEmpty: '説明はまだありません',
  runDescriptionEdit: '説明を編集',
  runDescriptionPlaceholder: '目的、条件、結果の所見などを書きます',
  comments: 'コメント',
  commentsEmpty: 'コメントはまだありません',
  commentsLoadMore: 'さらに読み込む',
  commentPlaceholder: 'コメントを書く',
  commentReplyPlaceholder: '返信を書く',
  commentPost: '投稿',
  commentReply: '返信',
  commentEdit: '編集',
  commentDelete: '削除',
  commentDeleteTitle: 'コメントを削除',
  commentDeleteMessage: 'このコメントを削除します。スレッドには「削除されました」と表示されます。',
  commentDeleted: '削除されました',
  commentEdited: '編集済み',
  commentBodyRequired: '本文を入力してください',
  commentActions: 'コメントの操作',
} as const;

// Text that embeds values; merged into catalog's textTemplates.
export const commentsTextTemplates = {
  markdownRemaining: (remaining: number) =>
    remaining >= 0 ? `残り ${remaining} 文字` : `${-remaining} 文字超過しています`,
  commentEditedAt: (editedAt: string) => `編集済み（${editedAt}）`,
};
