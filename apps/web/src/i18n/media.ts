// Media recorded per step: the Run media tab, the step comparison, and media tables. run-media-web owns the entries.
import type { RunMediaKind } from '@mmt/contracts';
import type { MediaTableCellFailure } from '../lib/mediaTableCells';
import { artifactReferenceErrorLabels, artifactsText } from './artifacts';

export const mediaText = {
  mediaKeys: 'メディアのキー',
  mediaKey: 'キー',
  mediaKind: '種類',
  mediaCount: '件数',
  mediaStepRange: 'step の範囲',
  mediaNoKeys: 'このRunにはstepごとのメディアが記録されていません。log_image・log_audio・log_table などで記録すると表示されます。',
  mediaStep: 'step',
  mediaStepSlider: '表示するstep',
  mediaPreviousStep: '前のstep',
  mediaNextStep: '次のstep',
  mediaStepHint: '矢印キーで前後のstep、Home・Endで最初と最後へ移動します。記録のあるstepだけに止まります。',
  mediaCaption: '説明',
  mediaTruncated: '記録が多いため、最初の10,000件だけを表示しています。',
  mediaCompareKey: '比較するキー',
  mediaCompareSteps: '比較するstep',
  mediaCompareStepsPlaceholder: '例: 0, 500, 1000（空欄なら各Runの最新step）',
  mediaCompareLatest: '各Runの最新step',
  mediaCompareApply: '表示',
  mediaCompareGrid: 'Run × step のメディア',
  mediaCompareMissing: 'なし',
  mediaCompareNoKeys: '選んだRunにはstepごとのメディアが記録されていません。',
  mediaCompareHint:
    '矢印キーでセルを移動します。音声は同時に1つだけ鳴り、別のセルへ移ると同じ再生位置から続けて再生します。',
  mediaCompareNoSelection: 'セルを選ぶと、ここに表示します。',
  mediaCompareStepsInvalid: 'stepは0以上の整数をカンマ区切りで入力してください。',
  mediaRun: 'Run',
  mediaTablePagination: '表のページ',
  mediaCellPlay: '再生',
  mediaCellPause: '一時停止',
  mediaCellWaveform: '波形',
  mediaCellOpen: '開く',
  mediaCellClose: '閉じる',
} as const;

export const mediaKindLabels: Record<RunMediaKind, string> = {
  audio: '音声',
  image: '画像',
  video: '動画',
  table: '表',
};

// The reference rules are the evaluation sample tables' (lib/evaluationSamples.ts), so their wording is reused.
export const mediaCellErrorLabels: Record<MediaTableCellFailure, string> = {
  empty: artifactReferenceErrorLabels.empty,
  absolute_path: artifactReferenceErrorLabels.absolute_path,
  parent_path: artifactReferenceErrorLabels.parent_path,
  unsupported_scheme: artifactReferenceErrorLabels.unsupported_scheme,
  invalid_run_reference: artifactReferenceErrorLabels.invalid_run_reference,
  other_project: artifactReferenceErrorLabels.other_project,
  not_found: artifactsText.evaluationAudioNotFound,
  unresolved: 'Artifactに解決できませんでした',
};

// Text that embeds values; merged into catalog's textTemplates.
export const mediaTextTemplates = {
  mediaStepPosition: (step: number, index: number, count: number) => `step ${step}（${index} / ${count}）`,
  mediaStepRangeValue: (minStep: number, maxStep: number) => (minStep === maxStep ? `${minStep}` : `${minStep}〜${maxStep}`),
  mediaItemCount: (count: number) => `${count}件`,
  mediaCompareRecordedSteps: (count: number, minStep: number, maxStep: number) =>
    `記録のあるstep: ${count}個（${minStep}〜${maxStep}）`,
  mediaCompareEvenly: (count: number) => `均等に${count}列`,
  mediaCompareTooManyRuns: (maximum: number) => `メディアの比較は最初の${maximum}件のRunだけを表示しています。`,
  mediaCompareTooManySteps: (maximum: number) => `比較できるstepは${maximum}個までです。`,
  mediaCompareFirstOfMany: (count: number) => `このstepには${count}件あります。最初の1件を表示しています。`,
  mediaCompareCell: (runLabel: string, step: number, state: string) => `${runLabel}、step ${step}、${state}`,
  mediaTableRowCount: (count: number) => `${count}行`,
  mediaTableErrorCells: (count: number) => `表示できないセル ${count}件`,
  mediaTablePage: (page: number, pageCount: number) => `${page} / ${pageCount}ページ`,
};
