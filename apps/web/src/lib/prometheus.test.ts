import { describe, expect, it } from 'vitest';
import { parsePrometheus } from './prometheus';

describe('parsePrometheus', () => {
  it('コメントを除いて指数表記とtimestampを読み取る', () => {
    const parsed = parsePrometheus(
      '# HELP size Bytes\r\n# TYPE size gauge\r\nsize 1.25e+6 1791388800000\r\n',
    );
    expect(parsed.invalidLineNumbers).toEqual([]);
    expect(parsed.samples).toEqual([
      { name: 'size', labels: {}, value: 1250000, rawValue: '1.25e+6', timestamp: '1791388800000' },
    ]);
  });

  it('label内のカンマ・波括弧・引用符・改行・backslashを値として保つ', () => {
    const parsed = parsePrometheus(
      String.raw`mado_storage_prefix_bytes{connection_id="c1", bucket="データ,{x}", prefix="path\\name\n\"quoted\"/",} 1024`,
    );
    expect(parsed.invalidLineNumbers).toEqual([]);
    expect(parsed.samples[0]?.labels).toEqual({
      connection_id: 'c1',
      bucket: 'データ,{x}',
      prefix: 'path\\name\n"quoted"/',
    });
  });

  it('大きい整数の元の精度と非有限値をゼロへ補完せず保持する', () => {
    const parsed = parsePrometheus('size 9007199254740993\nunknown NaN\nhigh +Inf\nlow -Inf\n');
    expect(parsed.samples[0]?.rawValue).toBe('9007199254740993');
    expect(Number.isNaN(parsed.samples[1]?.value)).toBe(true);
    expect(parsed.samples[2]?.value).toBe(Infinity);
    expect(parsed.samples[3]?.value).toBe(-Infinity);
  });

  it('不正なsampleを除き、行番号と有効なsampleを返す', () => {
    const parsed = parsePrometheus(String.raw`missing{bucket="a"}
bad 12oops
escaped{path="bad\t"} 1
duplicate{bucket="a",bucket="b"} 2
valid{bucket="a"} 0`);
    expect(parsed.invalidLineNumbers).toEqual([1, 2, 3, 4]);
    expect(parsed.samples).toHaveLength(1);
    expect(parsed.samples[0]?.value).toBe(0);
  });

  it('引用符で囲まれたUTF-8のmetric名とlabel名を読み取る', () => {
    const parsed = parsePrometheus('{"storage.容量", "connection.name"="テスト"} .5');
    expect(parsed.invalidLineNumbers).toEqual([]);
    expect(parsed.samples[0]).toEqual({
      name: 'storage.容量',
      labels: { 'connection.name': 'テスト' },
      value: 0.5,
      rawValue: '.5',
    });
  });

  it('label順だけが違う同じseriesの重複を検出し、値を勝手に選ばない', () => {
    const parsed = parsePrometheus(
      'size{bucket="a",connection_id="c1"} 3\nsize{connection_id="c1",bucket="a"} 5\nother 1',
    );
    expect(parsed.invalidLineNumbers).toEqual([1, 2]);
    expect(parsed.samples.map((sample) => sample.name)).toEqual(['other']);
  });
});
