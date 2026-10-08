// Dataset version content: the folder upload in the version dialog and the version's file list.

export const datasetsText = {
  datasetVersionFromFolder: 'フォルダから作る',
  datasetVersionOptional: '版（空なら自動採番）',
  datasetFolderHint:
    'フォルダを選ぶと、中のファイルをArtifactとしてuploadし、全部の保存が終わったら版を作ります。',
  datasetFolderChoose: 'フォルダを選択',
  datasetFolderUploadAndCreate: 'uploadして版を作成',
  datasetFolderCreating: '版を作成しています',
  datasetFolderRetryCreate: '版の作成を再試行',
  datasetFolderWaitingFailed: 'uploadに失敗したファイルがあります。再試行するか、ダイアログを閉じてください。',
  datasetContentKind: '本体',
  datasetContentReference: '参照（URI）',
  datasetFiles: 'ファイル',
  datasetFileCount: 'ファイル数',
  datasetTotalSize: '合計サイズ',
  datasetFilesReferenceOnly: 'この版はURIで登録した参照で、ファイル一覧を持ちません。',
  datasetFileSelect: 'ファイルを選ぶとプレビューを表示します。',
};

export const datasetsTextTemplates = {
  datasetFolderSelected: (count: number, size: string) => `${count}件のファイル（${size}）`,
  datasetContentArtifacts: (count: number, size: string) => `Artifact ${count}件 · ${size}`,
};
