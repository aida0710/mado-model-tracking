import { describe, expect, it } from 'vitest';
import {
  EVALUATION_SAMPLES_PAGE_SIZE,
  evaluationSampleFormat,
  isEvaluationSampleTable,
  paginate,
  parseEvaluationSamples,
  resolveArtifactReference,
  sortEvaluationSamples,
} from './evaluationSamples';

const PROJECT = '11111111-1111-4111-8111-111111111111';
const OTHER_PROJECT = '22222222-2222-4222-8222-222222222222';
const TABLE_RUN = '33333333-3333-4333-8333-333333333333';
const UPSTREAM_RUN = '44444444-4444-4444-8444-444444444444';
const context = { projectId: PROJECT, tableRunId: TABLE_RUN };

describe('評価サンプルの読み込み', () => {
  it('jsonlの壊れた行を補完せずエラーとして行番号つきで数え、空行は無視する', () => {
    const content = [
      '{"audio":"a.wav","reference":"こんにちは","prediction":"こんにちわ","score":0.2}',
      '',
      '{"audio":"b.wav","reference":"はい"',
      '[1,2]',
      '{"audio":"c.wav","reference":"x","prediction":"y","score":"高い"}',
      '{"audio":3,"reference":"x","prediction":"y"}',
      '{"audio":"d.wav","reference":"x","prediction":"y"}',
    ].join('\n');
    const table = parseEvaluationSamples(content, 'jsonl');
    expect(table.samples).toEqual([
      { line: 1, audio: 'a.wav', reference: 'こんにちは', prediction: 'こんにちわ', score: 0.2 },
      { line: 7, audio: 'd.wav', reference: 'x', prediction: 'y', score: null },
    ]);
    expect(table.errors).toEqual([
      { line: 3, reason: 'invalid_json' },
      { line: 4, reason: 'not_object' },
      { line: 5, reason: 'invalid_score' },
      { line: 6, reason: 'invalid_text' },
    ]);
    expect(isEvaluationSampleTable(table.columns)).toBe(true);
  });

  it('csvは引用符内の改行・カンマ・二重引用符を読み、列数の違う行と閉じない引用符をエラーにする', () => {
    const content = '﻿audio,reference,prediction,score\r\n' +
      'a.wav,"今日は、晴れ","今日は""晴れ""",0.5\r\n' +
      'b.wav,"一行目\n二行目",二行目,1\n' +
      'c.wav,x\n' +
      'd.wav,x,y,abc\n' +
      'e.wav,"閉じない,y,1\n';
    const table = parseEvaluationSamples(content, 'csv');
    expect(table.columns).toEqual(['audio', 'reference', 'prediction', 'score']);
    expect(table.samples).toEqual([
      { line: 2, audio: 'a.wav', reference: '今日は、晴れ', prediction: '今日は"晴れ"', score: 0.5 },
      { line: 3, audio: 'b.wav', reference: '一行目\n二行目', prediction: '二行目', score: 1 },
    ]);
    expect(table.errors).toEqual([
      { line: 5, reason: 'column_count' },
      { line: 6, reason: 'invalid_score' },
      { line: 7, reason: 'unterminated_quote' },
    ]);
  });

  it('audioもreference・predictionの組も無い表は評価サンプルとして扱わない', () => {
    expect(isEvaluationSampleTable(['step', 'loss'])).toBe(false);
    expect(isEvaluationSampleTable(['reference', 'prediction'])).toBe(true);
    expect(isEvaluationSampleTable(['audio'])).toBe(true);
  });

  it('拡張子とMIMEから形式を判定する', () => {
    expect(evaluationSampleFormat('eval/results.jsonl', 'application/octet-stream')).toBe('jsonl');
    expect(evaluationSampleFormat('x', 'application/x-ndjson; charset=utf-8')).toBe('jsonl');
    expect(evaluationSampleFormat('eval/results.CSV', 'text/plain')).toBe('csv');
    expect(evaluationSampleFormat('notes.txt', 'text/plain')).toBeNull();
  });
});

describe('並べ替えとページング', () => {
  const samples = [
    { line: 1, audio: null, reference: null, prediction: null, score: 0.5 },
    { line: 2, audio: null, reference: null, prediction: null, score: null },
    { line: 3, audio: null, reference: null, prediction: null, score: 0.1 },
    { line: 4, audio: null, reference: null, prediction: null, score: 0.5 },
  ];

  it('スコア順はどちらの向きでもスコアの無い行を最後に置き、同点は行順を保つ', () => {
    expect(sortEvaluationSamples(samples, 'score_asc').map((item) => item.line)).toEqual([3, 1, 4, 2]);
    expect(sortEvaluationSamples(samples, 'score_desc').map((item) => item.line)).toEqual([1, 4, 3, 2]);
    expect(sortEvaluationSamples(samples, 'line').map((item) => item.line)).toEqual([1, 2, 3, 4]);
  });

  it('1ページ50行で区切り、範囲外のページは端に丸める', () => {
    const items = Array.from({ length: 120 }, (_, index) => index);
    expect(EVALUATION_SAMPLES_PAGE_SIZE).toBe(50);
    const last = paginate(items, 2);
    expect(last).toEqual({ items: items.slice(100), page: 2, pageCount: 3 });
    expect(paginate(items, 99).page).toBe(2);
    expect(paginate(items, -1).items[0]).toBe(0);
    expect(paginate([], 0)).toEqual({ items: [], page: 0, pageCount: 1 });
  });
});

describe('audio列のパス解決', () => {
  it('相対パスは表と同じRunのArtifactとして、Runのrootから解決する', () => {
    expect(resolveArtifactReference('./audio//001.wav', context)).toEqual({
      ok: true,
      reference: { runId: TABLE_RUN, path: 'audio/001.wav' },
    });
  });

  it('mmt-artifact://runs/<runId>/<path> は別のRunのArtifactを指す', () => {
    expect(resolveArtifactReference(`mmt-artifact://runs/${UPSTREAM_RUN}/outputs/a b.wav`, context)).toEqual({
      ok: true,
      reference: { runId: UPSTREAM_RUN, path: 'outputs/a b.wav' },
    });
    expect(
      resolveArtifactReference(`mmt-artifact://projects/${PROJECT}/runs/${UPSTREAM_RUN}/x.wav`, context),
    ).toEqual({ ok: true, reference: { runId: UPSTREAM_RUN, path: 'x.wav' } });
  });

  it('他Projectの参照、不正な形式、Runの外を指すパスを拒否する', () => {
    const errorOf = (value: string, tableRunId: string | null = TABLE_RUN) => {
      const result = resolveArtifactReference(value, { projectId: PROJECT, tableRunId });
      return result.ok ? null : result.error;
    };
    expect(errorOf(`mmt-artifact://projects/${OTHER_PROJECT}/runs/${UPSTREAM_RUN}/x.wav`)).toBe('other_project');
    expect(errorOf('mmt-artifact://runs/not-a-uuid/x.wav')).toBe('invalid_run_reference');
    expect(errorOf(`mmt-artifact://models/${UPSTREAM_RUN}/x.wav`)).toBe('invalid_run_reference');
    expect(errorOf(`mmt-artifact://runs/${UPSTREAM_RUN}/`)).toBe('empty');
    expect(errorOf(`mmt-artifact://runs/${UPSTREAM_RUN}/../secret.wav`)).toBe('parent_path');
    expect(errorOf('../other/a.wav')).toBe('parent_path');
    expect(errorOf('/etc/passwd')).toBe('absolute_path');
    expect(errorOf('s3://bucket/a.wav')).toBe('unsupported_scheme');
    expect(errorOf('https://example.invalid/a.wav')).toBe('unsupported_scheme');
    expect(errorOf('   ')).toBe('empty');
    expect(errorOf('a.wav', null)).toBe('no_table_run');
  });
});
