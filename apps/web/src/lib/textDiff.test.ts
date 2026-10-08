import { describe, expect, it } from 'vitest';
import { TEXT_DIFF_MAX_CELLS, diffCharacters } from './textDiff';

const join = (segments: ReturnType<typeof diffCharacters>, kinds: string[]) =>
  (segments ?? []).filter((segment) => kinds.includes(segment.kind)).map((segment) => segment.text).join('');

describe('文字単位の差分', () => {
  it('日本語を1文字ずつ比べ、置換を削除と挿入で示す', () => {
    const segments = diffCharacters('今日は晴れです', '今日は雨です');
    expect(segments).toEqual([
      { kind: 'equal', text: '今日は' },
      { kind: 'delete', text: '晴れ' },
      { kind: 'insert', text: '雨' },
      { kind: 'equal', text: 'です' },
    ]);
  });

  it('差分から参照と推論の両方を元どおりに復元できる', () => {
    const reference = 'こんにちは、世界。音声認識のテスト';
    const prediction = 'こんちには世界！音声認識テストです';
    const segments = diffCharacters(reference, prediction);
    expect(join(segments, ['equal', 'delete'])).toBe(reference);
    expect(join(segments, ['equal', 'insert'])).toBe(prediction);
  });

  it('サロゲートペアの絵文字を1文字として扱う', () => {
    expect(diffCharacters('a😀b', 'a😃b')).toEqual([
      { kind: 'equal', text: 'a' },
      { kind: 'delete', text: '😀' },
      { kind: 'insert', text: '😃' },
      { kind: 'equal', text: 'b' },
    ]);
  });

  it('空文字列との比較は全体が削除または挿入になる', () => {
    expect(diffCharacters('', 'あ')).toEqual([{ kind: 'insert', text: 'あ' }]);
    expect(diffCharacters('あ', '')).toEqual([{ kind: 'delete', text: 'あ' }]);
    expect(diffCharacters('', '')).toEqual([]);
  });

  it('上限を超える長さは比較せずnullを返す', () => {
    const long = 'あ'.repeat(Math.ceil(Math.sqrt(TEXT_DIFF_MAX_CELLS)) + 1);
    expect(diffCharacters(long, long)).toBeNull();
  });
});
