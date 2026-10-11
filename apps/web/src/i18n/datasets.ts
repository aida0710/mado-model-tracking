// Dataset version content: the folder upload in the version dialog and the version's file list.

export const datasetsText = {
  datasetVersionFromFolder: 'フォルダから作る',
  datasetVersionOptional: 'バージョン（空なら自動採番）',
  datasetFolderHint:
    'フォルダを選ぶと、中のファイルをArtifactとしてuploadし、全部の保存が終わったらバージョンを作ります。',
  datasetFolderChoose: 'フォルダを選択',
  datasetFolderUploadAndCreate: 'uploadしてバージョンを作成',
  datasetFolderCreating: 'バージョンを作成しています',
  datasetFolderRetryCreate: 'バージョンの作成を再試行',
  datasetFolderResendUnfinished: '残りのファイルを再送',
  datasetFolderCreateWithoutUnfinished: '残りのファイルを除いてバージョンを作成',
  datasetContentKind: '本体',
  datasetContentReference: '参照（URI）',
  datasetFiles: 'ファイル',
  datasetFileCount: 'ファイル数',
  datasetTotalSize: '合計サイズ',
  datasetFilesReferenceOnly: 'このバージョンはURIで登録した参照で、ファイル一覧を持ちません。',
  datasetFileSelect: 'ファイルを選ぶとプレビューを表示します。',
};

export const datasetsTextTemplates = {
  datasetFolderSelected: (count: number, size: string) => `${count}件のファイル（${size}）`,
  datasetFolderUnfinished: (unfinished: number, stored: number) =>
    `${unfinished}件のファイルがuploadされていないため、バージョンはまだ作っていません。再送するか、それらを除いてバージョンを作ってください。` +
    (stored > 0 ? `閉じると、upload済みの${stored}件はどのバージョンにも属さないArtifact（Runなし）として残ります。` : ''),
  datasetContentArtifacts: (count: number, size: string) => `Artifact ${count}件 · ${size}`,
};
