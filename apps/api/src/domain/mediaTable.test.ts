import { describe, expect, it } from 'vitest';
import { DomainError } from './errors.js';
import { isParquetTable, mediaCellReference, parseMediaTable } from './mediaTable.js';

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const TABLE_RUN_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_RUN_ID = '33333333-3333-4333-8333-333333333333';
const context = { projectId: PROJECT_ID, tableRunId: TABLE_RUN_ID };

function tableError(content: string): DomainError {
  try {
    parseMediaTable(content);
  } catch (error) {
    return error as DomainError;
  }
  throw new Error('parseMediaTable accepted the table');
}

describe('parseMediaTable', () => {
  it('MLflow log_tableのsplit形式を列の型つきで読む', () => {
    const table = parseMediaTable(
      JSON.stringify({
        columns: ['text', 'score', 'extra'],
        data: [
          ['こんにちは', 0.9, { a: 1 }],
          ['hello', null, 'x'],
        ],
      }),
    );
    expect(table.columns).toEqual([
      { name: 'text', type: 'text' },
      { name: 'score', type: 'number' },
      { name: 'extra', type: 'json' },
    ]);
    expect(table.rows).toHaveLength(2);
  });

  it('MLflowの画像セルとnativeの音声セルを媒体の列にする', () => {
    const table = parseMediaTable(
      JSON.stringify({
        columns: ['image', 'audio', 'reference'],
        data: [
          [
            {
              type: 'image',
              filepath: 'table_images/eval/a.png',
              compressed_filepath: 'table_images/eval/a.webp',
            },
            { type: 'audio', filepath: 'audio/a.wav' },
            `mmt-artifact://runs/${OTHER_RUN_ID}/audio/ref.wav`,
          ],
          [null, { type: 'audio', filepath: 'audio/b.wav' }, null],
        ],
      }),
    );
    expect(table.columns.map((column) => column.type)).toEqual(['image', 'audio', 'audio']);
  });

  it('種類の違う媒体が混ざった列はjsonにする', () => {
    const table = parseMediaTable(
      JSON.stringify({
        columns: ['mixed'],
        data: [[{ type: 'image', filepath: 'a.png' }], [{ type: 'audio', filepath: 'a.wav' }]],
      }),
    );
    expect(table.columns[0]!.type).toBe('json');
  });

  it.each([
    ['壊れたJSON', '{"columns": ["a"], "data": [[1]'],
    ['配列', '[1, 2]'],
    ['columnsが無い', '{"data": []}'],
    ['列数の違う行', '{"columns": ["a", "b"], "data": [[1]]}'],
    ['列名が文字列でない', '{"columns": [1], "data": [[1]]}'],
  ])('%sは422 media_table_invalid', (_label, content) => {
    const error = tableError(content);
    expect(error).toBeInstanceOf(DomainError);
    expect(error.status).toBe(422);
    expect(error.code).toBe('media_table_invalid');
  });

  it('BOM付きのJSONも読む', () => {
    expect(parseMediaTable('﻿{"columns":["a"],"data":[["x"]]}').rows).toEqual([['x']]);
  });
});

describe('mediaCellReference', () => {
  it('相対pathは表のRunのArtifactを指す', () => {
    expect(
      mediaCellReference(
        { type: 'image', filepath: './table_images/a.png', compressed_filepath: 'table_images/a.webp' },
        context,
      ),
    ).toEqual({
      type: 'image',
      file: { ok: true, reference: { runId: TABLE_RUN_ID, path: 'table_images/a.png' } },
      thumbnail: { ok: true, reference: { runId: TABLE_RUN_ID, path: 'table_images/a.webp' } },
    });
  });

  it('mmt-artifact://で別のRunを指せる', () => {
    expect(
      mediaCellReference(`mmt-artifact://projects/${PROJECT_ID}/runs/${OTHER_RUN_ID}/audio/x.wav`, context),
    ).toEqual({
      type: 'audio',
      file: { ok: true, reference: { runId: OTHER_RUN_ID, path: 'audio/x.wav' } },
      thumbnail: null,
    });
  });

  it('他Projectの参照は解決しない', () => {
    const otherProject = '44444444-4444-4444-8444-444444444444';
    expect(
      mediaCellReference(`mmt-artifact://projects/${otherProject}/runs/${OTHER_RUN_ID}/a.wav`, context)?.file,
    ).toEqual({ ok: false, error: 'other_project' });
  });

  it.each([
    ['Run IDでない', { type: 'audio', filepath: 'mmt-artifact://runs/not-a-run/a.wav' }, 'invalid_run_reference'],
    ['runs以外', { type: 'audio', filepath: 'mmt-artifact://models/x/a.wav' }, 'invalid_run_reference'],
    ['親への移動', { type: 'audio', filepath: 'audio/../../secret.wav' }, 'parent_path'],
    ['絶対path', { type: 'audio', filepath: '/etc/passwd.wav' }, 'absolute_path'],
    ['別のscheme', { type: 'image', filepath: 's3://bucket/a.png' }, 'unsupported_scheme'],
    ['空', { type: 'image', filepath: '  ' }, 'empty'],
  ])('%sは解決しない', (_label, cell, error) => {
    expect(mediaCellReference(cell, context)?.file).toEqual({ ok: false, error });
  });

  it('媒体でないセルはnull', () => {
    expect(mediaCellReference('audio/a.wav', context)).toBeNull();
    expect(mediaCellReference({ type: 'text', filepath: 'a' }, context)).toBeNull();
    expect(mediaCellReference('mmt-artifact://runs/x/a.txt', context)).toBeNull();
  });
});

describe('isParquetTable', () => {
  it('拡張子かMIME typeでparquetを見分ける', () => {
    expect(isParquetTable({ path: 'tables/a.parquet', mimeType: 'application/octet-stream' })).toBe(true);
    expect(isParquetTable({ path: 'tables/a', mimeType: 'application/vnd.apache.parquet' })).toBe(true);
    expect(isParquetTable({ path: 'tables/a.json', mimeType: 'application/json' })).toBe(false);
  });
});
