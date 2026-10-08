// Saved views of the Run list (menu, save dialog, notices) and the column controls they keep.
export const savedViewsText = {
  savedViews: 'ビュー',
  savedViewDefault: '既定の表示',
  savedViewPrivateGroup: '自分用',
  savedViewProjectGroup: 'プロジェクトで共有',
  savedViewNone: '保存したビューはまだありません',
  savedViewUnsaved: '未保存の変更',
  savedViewSave: '上書き保存',
  savedViewSaveAs: '名前を付けて保存',
  savedViewRename: '名前を変更',
  savedViewDelete: '削除',
  savedViewDeleteTitle: 'ビューを削除',
  savedViewCopyUrl: 'URLをコピー',
  savedViewUrlCopied: 'URLをコピーしました',
  savedViewName: 'ビューの名前',
  savedViewVisibility: '公開範囲',
  savedViewVisibilityPrivate: '自分だけ',
  savedViewVisibilityPrivateHint: 'ほかのメンバーには一覧にもURLにも表示されません。',
  savedViewVisibilityProject: 'プロジェクトで共有',
  savedViewVisibilityProjectHint: 'このプロジェクトのメンバー全員が開けます。',
  savedViewNotFound:
    '開こうとしたビューは削除されたか、閲覧できません（ほかの人の自分用のビューを含む）。既定の表示を開きました。',
  savedViewUnsupportedVersion:
    'このビューは新しい形式で保存されているため、この画面では開けません。既定の表示を開きました。',
  savedViewInvalid: 'このビューの内容を読み取れませんでした。既定の表示を開きました。',
  savedViewShared: '共有',
  runDescriptionColumn: '説明',
  runColumnResize: '列の幅を変更',
  runColumnMove: '列を移動（Alt+←/→）',
} as const;

// Text that embeds values; merged into catalog's textTemplates.
export const savedViewsTextTemplates = {
  savedViewDeleteMessage: (name: string) =>
    `ビュー「${name}」を削除します。このビューのURLを開いた人には既定の表示が出ます。`,
  savedViewCurrent: (name: string) => `ビュー: ${name}`,
};
