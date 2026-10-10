import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { CodeView } from './CodeView';

function storage(values: Record<string, string>) {
  const items = new Map(Object.entries(values));
  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('CodeView', () => {
  it('形式を推測して色を付け、選択欄の「自動」に推測した形式を出す', () => {
    const markup = renderToStaticMarkup(
      <CodeView content={'model:\n  layers: 12\n'} fileName="runs/r1/config.yaml" mimeType="text/plain" />,
    );
    expect(markup).toContain('<option value="auto" selected="">自動（YAML）</option>');
    expect(markup).toContain('<pre class="code-view"><code>');
    expect(markup).toContain('<span class="hljs-attr">model:</span>');
  });

  it('形式の分からない文章は「テキスト」とし、色を付けずに逃がすだけ', () => {
    const markup = renderToStaticMarkup(<CodeView content="ただのメモ & 覚え書き" fileName="memo.txt" />);
    expect(markup).toContain('<option value="auto" selected="">自動（テキスト）</option>');
    expect(markup).toContain('<code>ただのメモ &amp; 覚え書き</code>');
  });

  it('同じ拡張子で選んだ形式を覚えていれば、推測より先に使う', () => {
    vi.stubGlobal('localStorage', storage({ 'mmt.codeLanguage': JSON.stringify({ out: 'log' }) }));
    const markup = renderToStaticMarkup(
      <CodeView content={'2026-10-10 12:00:00 ERROR failed\n'} fileName="logs/stdout.out" />,
    );
    expect(markup).toContain('<option value="log" selected="">ログ</option>');
    expect(markup).toContain('<span class="code-log-level code-log-error">ERROR</span>');
  });

  it('Object のメンバーと同じ名前の拡張子でも、覚えていなければ推測を使う', () => {
    vi.stubGlobal('localStorage', storage({ 'mmt.codeLanguage': '{}' }));
    const markup = renderToStaticMarkup(<CodeView content="plain" fileName="notes.constructor" />);
    expect(markup).toContain('<option value="auto" selected="">自動（テキスト）</option>');
  });

  it('覚えている値が形式でなければ無視して推測に戻る', () => {
    vi.stubGlobal('localStorage', storage({ 'mmt.codeLanguage': JSON.stringify({ json: 'javascript' }) }));
    const markup = renderToStaticMarkup(<CodeView content={'{"a": 1}'} fileName="a.json" />);
    expect(markup).toContain('<option value="auto" selected="">自動（JSON）</option>');
  });
});
