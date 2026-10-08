// Artifact deletion (the file menu in the Run browser) and the usage table in Project settings.
export const artifactLifecycleText = {
  artifactActions: 'ファイルの操作',
  artifactDelete: '削除',
  artifactDeleteTitle: 'Artifactを削除',
  artifactUsage: 'Artifactの使用量',
  artifactUsageEmpty: 'Artifactはまだありません',
  artifactUsageBackend: '保存先',
  artifactUsageCount: '件数',
  artifactUsageBytes: '容量',
  artifactUsagePendingDeletion: '削除待ち',
  artifactUsageOldVersions: '参照されていない古い版',
};

export const artifactLifecycleTextTemplates = {
  artifactDeleteConfirm: (path: string) =>
    `「${path}」を削除します。一覧と取得からはすぐに消え、元に戻せません。同じパスに前の版があれば、それが表示されるようになります。`,
  artifactUsageNote: (graceDays: number) =>
    `削除したArtifactの実ファイルは${graceDays}日後に回収します。古い版は自動では削除しません。`,
  artifactUsageFiles: (count: number, size: string) => `${count}件 · ${size}`,
};
