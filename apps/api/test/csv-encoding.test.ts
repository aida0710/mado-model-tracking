import { describe, expect, it } from 'vitest';
import {
  CSV_BYTE_ORDER_MARK,
  csvAttachmentDisposition,
  encodeCsvCell,
  encodeCsvDocument,
  encodeCsvLine,
} from '../src/domain/csvEncoding.js';

describe('CSVの符号化', () => {
  it('カンマ・改行・引用符を含むセルは引用符で囲み、引用符を二重にする', () => {
    expect(encodeCsvCell('a,b')).toBe('"a,b"');
    expect(encodeCsvCell('1行目\n2行目')).toBe('"1行目\n2行目"');
    expect(encodeCsvCell('say "hi"')).toBe('"say ""hi"""');
    expect(encodeCsvCell('plain')).toBe('plain');
  });

  it('日本語はそのまま書き、文書の先頭にBOMを付けて行はCRLFで終える', () => {
    const document = encodeCsvDocument([
      ['名前', '損失'],
      ['学習Run', 0.25],
    ]);
    expect(document.startsWith(CSV_BYTE_ORDER_MARK)).toBe(true);
    expect(document.slice(CSV_BYTE_ORDER_MARK.length)).toBe('名前,損失\r\n学習Run,0.25\r\n');
  });

  it('数式として解釈される文字で始まる文字列には先頭に引用符を付ける', () => {
    expect(encodeCsvCell('=HYPERLINK("http://x")')).toBe(`"'=HYPERLINK(""http://x"")"`);
    expect(encodeCsvCell('+1')).toBe("'+1");
    expect(encodeCsvCell('-2')).toBe("'-2");
    expect(encodeCsvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(encodeCsvCell('\tcmd')).toBe("'\tcmd");
    // CR also needs quoting, so the guard and the quotes are both applied.
    expect(encodeCsvCell('\rcmd')).toBe(`"'\rcmd"`);
  });

  it('数値は負の値やNaNでも数式対策をせずそのまま書く', () => {
    expect(encodeCsvCell(-0.5)).toBe('-0.5');
    expect(encodeCsvCell(Number.NaN)).toBe('NaN');
    expect(encodeCsvCell(Number.NEGATIVE_INFINITY)).toBe('-Infinity');
    expect(encodeCsvCell(true)).toBe('true');
  });

  it('nullとundefinedと空文字は空のセルになる', () => {
    expect(encodeCsvLine([null, undefined, '', 'x'])).toBe(',,,x\r\n');
  });

  it('添付ファイル名は日本語をRFC 5987で、ASCIIの代替名は記号を置き換えて渡す', () => {
    expect(csvAttachmentDisposition('runs-20261008.csv')).toBe(
      `attachment; filename="runs-20261008.csv"; filename*=UTF-8''runs-20261008.csv`,
    );
    expect(csvAttachmentDisposition('比較"a".csv')).toBe(
      `attachment; filename="___a_.csv"; filename*=UTF-8''${encodeURIComponent('比較"a".csv')}`,
    );
  });
});
