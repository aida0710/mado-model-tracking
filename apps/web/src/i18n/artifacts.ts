// Artifact preview, size limit, audio viewer, evaluation samples, and Artifact comparison labels.
import type { EvaluationSampleErrorReason, ArtifactReferenceError } from '../lib/evaluationSamples';

export const artifactsText = {
  artifactTooLarge: 'Artifactが上限サイズを超えています。管理者に上限を確認してください。',
  audioPlay: '再生',
  audioPause: '一時停止',
  audioZoomIn: '拡大',
  audioZoomOut: '縮小',
  audioZoomReset: '全体を表示',
  audioPan: '表示位置',
  audioChannel: 'チャンネル',
  audioChannelMix: 'すべて（平均）',
  audioSpectrogramScale: 'スペクトログラム',
  audioScaleLinear: '線形',
  audioScaleMel: 'mel',
  audioLoopClear: 'ループを解除',
  audioTimeline: '再生位置',
  audioTimelineHint: 'クリックでその位置へ移動し、ドラッグした範囲をループ再生します。',
  audioSampleRate: 'サンプルレート',
  audioSampleRateDecoded: '（ファイルから読めないため再生時のレート）',
  audioDuration: '長さ',
  audioChannels: 'チャンネル数',
  audioAnalysisSkipped: '64MiBを超えるため、波形とスペクトログラムは表示しません。再生はできます。',
  audioFetchError: '音声の取得に失敗しました',
  audioDecodeError: '音声をデコードできませんでした。ブラウザが対応していない形式の可能性があります。',
  audioAnalysisError: '波形とスペクトログラムの計算に失敗しました',
  audioPlaybackError: '音声を再生できませんでした',
  evaluationLineColumn: '行',
  evaluationOrderLine: 'ファイルの順',
  evaluationOrderScoreAscending: 'scoreの低い順',
  evaluationOrderScoreDescending: 'scoreの高い順',
  evaluationHighlightDiff: '差分を強調',
  evaluationBrokenRows: '読み取れない行',
  evaluationShowWaveform: '波形',
  evaluationPagination: '評価サンプルのページ',
  evaluationAudioNotFound: 'Artifactが見つかりません',
  evaluationAudioRunUnavailable: '参照先のRunがこのプロジェクトにありません',
  evaluationAudioLookupError: 'Artifactの一覧を取得できませんでした',
  compareCommonPaths: '共通の保存パス',
  compareNoCommonArtifacts: '選択したすべてのRunに共通する保存パスはありません',
  compareSwitchPlayback: '同じ位置から再生',
} as const;

export const artifactsTextTemplates = {
  audioChannelNumber: (channel: number) => `チャンネル${channel}`,
  audioSampleRateValue: (hertz: number) => `${hertz.toLocaleString('ja-JP')} Hz`,
  audioMaxFrequency: (hertz: number) => `${(hertz / 1000).toLocaleString('ja-JP', { maximumFractionDigits: 1 })} kHz`,
  evaluationSampleCount: (count: number) => `${count.toLocaleString('ja-JP')}件のサンプル`,
  evaluationBrokenRowCount: (count: number) => `読み取れない行 ${count.toLocaleString('ja-JP')}件`,
  evaluationLine: (line: number) => `${line}行目`,
  evaluationPage: (page: number, pageCount: number) => `${page} / ${pageCount}ページ`,
};

export const evaluationSampleErrorLabels: Record<EvaluationSampleErrorReason, string> = {
  invalid_json: 'JSONとして読み取れません',
  not_object: 'JSONオブジェクトではありません',
  column_count: '列数がヘッダーと一致しません',
  unterminated_quote: '引用符が閉じていません',
  invalid_text: 'audio・reference・predictionが文字列ではありません',
  invalid_score: 'scoreが数値ではありません',
};

export const artifactReferenceErrorLabels: Record<ArtifactReferenceError, string> = {
  empty: 'パスが空です',
  absolute_path: '絶対パスは使えません。Runの保存パスを書いてください',
  parent_path: '「..」でRunの外は指せません',
  unsupported_scheme: 'mmt-artifact://runs/<Run ID>/<保存パス> の形式で書いてください',
  invalid_run_reference: 'mmt-artifact://runs/<Run ID>/<保存パス> の形式で書いてください',
  other_project: '別のプロジェクトのArtifactは参照できません',
  no_table_run: 'Runに属さない表では、相対パスを解決できません',
};
