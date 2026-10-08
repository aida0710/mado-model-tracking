// Artifact upload dialog and queue: progress, pause, cancel, resume. web-resumable-upload-manager owns the entries.
import type { UploadItemStatus } from '../hooks/useArtifactUploadQueue';

export const uploadsText = {
  uploadChooseFiles: 'ファイルを選ぶ',
  uploadChooseFolder: 'フォルダを選ぶ',
  uploadDropHint: 'ここにファイルやフォルダをドロップできます',
  uploadDestination: '保存先フォルダ',
  uploadDestinationHint: 'フォルダを選んだときは、フォルダ内の構成を保ったままこの下に置きます。',
  uploadSelectedFiles: '選んだファイル',
  uploadClearSelection: '選び直す',
  uploadStart: 'アップロードを開始',
  uploadQueue: 'アップロードの進み具合',
  uploadPause: '一時停止',
  uploadResume: '再開',
  uploadCancel: '取消',
  uploadRetryFailed: '失敗したファイルを再送',
  uploadVerificationFailed: 'サーバーでの検証に失敗しました',
  uploadCancelNotSent: '取消をサーバーへ送れませんでした。受信済みの部分は期限（7日）で消えます',
  uploadResumableSessions: '途中のアップロード',
  uploadResumableHint: '同じファイルを同じ保存パスで選び直すと、受信済みの部分を除いて続きから送ります。',
  uploadDiscardSession: '破棄',
  uploadExpires: '期限',
  uploadInProgressNotice: 'アップロード中は閉じられません。一時停止か取消をしてから閉じてください。',
} as const;

export const uploadStatusLabels: Record<UploadItemStatus, string> = {
  queued: '待機中',
  preparing: '準備中',
  uploading: '送信中',
  verifying: 'サーバーで検証中',
  paused: '一時停止',
  failed: '失敗',
  canceled: '取消済み',
  completed: '完了',
};

// Text that embeds values; merged into catalog's textTemplates.
export const uploadsTextTemplates = {
  uploadSelectedCount: (count: number, totalSize: string) => `${count}件（${totalSize}）`,
  uploadTransferRate: (rate: string) => `${rate}/秒`,
  uploadRemainingTime: (duration: string) => `残り ${duration}`,
  uploadResumedBytes: (size: string) => `前回の続きから（${size} は送信済み）`,
  uploadProgressSummary: (done: number, total: number) => `${done} / ${total} 件完了`,
};
