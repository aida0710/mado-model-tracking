import type { MediaTableColumn } from '@mmt/contracts';
import { describe, expect, it } from 'vitest';
import { countErrorCells, describeTableCell, tablePageCount } from './mediaTableCells';

const image: MediaTableColumn = { name: 'image', type: 'image' };
const audio: MediaTableColumn = { name: 'audio', type: 'audio' };
const resolved = (type: 'audio' | 'image', path: string, artifactId: string, thumbnailArtifactId: string | null = null) => ({
  type,
  runId: 'run',
  path,
  artifactId,
  thumbnailArtifactId,
  error: null,
});
const failed = (type: 'audio' | 'image', path: string | null, error: string) => ({
  type,
  runId: null,
  path,
  artifactId: null,
  thumbnailArtifactId: null,
  error,
});

describe('メディア表のセル', () => {
  it('解決済みの画像セルはthumbnailとともにメディアとして表示する', () => {
    expect(describeTableCell(image, resolved('image', 'table_images/a.png', 'a1', 'a2'))).toEqual({
      kind: 'media',
      media: { type: 'image', runId: 'run', path: 'table_images/a.png', artifactId: 'a1', thumbnailArtifactId: 'a2' },
    });
  });

  it('APIが解決できなかった参照はエラーセルにし、理由を保つ', () => {
    expect(describeTableCell(audio, failed('audio', 'mmt-artifact://projects/x/runs/y/a.wav', 'other_project'))).toEqual({
      kind: 'error',
      reason: 'other_project',
      path: 'mmt-artifact://projects/x/runs/y/a.wav',
    });
    expect(describeTableCell(audio, failed('audio', null, 'invalid_run_reference'))).toEqual({
      kind: 'error',
      reason: 'invalid_run_reference',
      path: '',
    });
    expect(describeTableCell(audio, failed('audio', 'a.wav', 'something_new'))).toMatchObject({ kind: 'error', reason: 'unresolved' });
  });

  it('MLflowの書いたままのセルやmmt-artifactの文字列は推測で解決しない', () => {
    expect(describeTableCell(image, { type: 'image', filepath: 'table_images/a.png' })).toEqual({
      kind: 'error',
      reason: 'unresolved',
      path: 'table_images/a.png',
    });
    expect(describeTableCell(audio, 'mmt-artifact://runs/r/a.wav')).toMatchObject({ kind: 'error', reason: 'unresolved' });
  });

  it('値の無いメディアセルはエラーにしない', () => {
    expect(describeTableCell(audio, null)).toEqual({ kind: 'empty' });
  });

  it('文字・数値・JSONの列はそのまま表示する', () => {
    expect(describeTableCell({ name: 'text', type: 'text' }, 'こんにちは')).toEqual({ kind: 'text', text: 'こんにちは' });
    expect(describeTableCell({ name: 'score', type: 'number' }, 0.25)).toEqual({ kind: 'number', text: '0.25' });
    expect(describeTableCell({ name: 'meta', type: 'json' }, { a: [1] })).toEqual({ kind: 'json', text: '{"a":[1]}' });
    expect(describeTableCell({ name: 'flag', type: 'text' }, true)).toEqual({ kind: 'text', text: 'true' });
  });

  it('ページ内のエラーセルを数える', () => {
    const columns: MediaTableColumn[] = [{ name: 'caption', type: 'text' }, image, audio];
    const rows = [
      ['a', resolved('image', 'a.png', 'a1'), failed('audio', 'x.wav', 'not_found')],
      ['b', { type: 'image', filepath: 'b.png' }, null],
      ['{"type":"image"}', null, resolved('audio', 'y.wav', 'y1')],
    ];
    expect(countErrorCells(columns, rows)).toBe(2);
  });

  it('空の表も1ページとして数える', () => {
    expect(tablePageCount(0)).toBe(1);
    expect(tablePageCount(50)).toBe(1);
    expect(tablePageCount(51)).toBe(2);
  });
});
