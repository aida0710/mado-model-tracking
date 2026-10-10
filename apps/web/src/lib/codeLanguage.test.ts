import { describe, expect, it } from 'vitest';
import {
  CODE_LANGUAGES,
  detectLanguage,
  guessLanguage,
  highlightCode,
  HIGHLIGHT_MAX_CHARS,
  isCodeLanguage,
  languageFromMimeType,
  languageFromName,
} from '@mado/design-tokens/code';

// The format detection and coloring that @mado/design-tokens/code shares with Mado.
describe('code language', () => {
  it('ファイル名の拡張子と特別な名前から形式を決め、言えないときは null', () => {
    expect(languageFromName('runs/metrics.jsonl')).toBe('json');
    expect(languageFromName('config.YML')).toBe('yaml');
    expect(languageFromName('pyproject.toml')).toBe('toml');
    expect(languageFromName('setup.cfg')).toBe('ini');
    expect(languageFromName('.env.local')).toBe('properties');
    expect(languageFromName('Dockerfile')).toBe('dockerfile');
    expect(languageFromName('train.py')).toBe('python');
    expect(languageFromName('results.tsv')).toBe('tsv');
    expect(languageFromName('notes.txt')).toBeNull();
    expect(languageFromName('README')).toBeNull();
    expect(languageFromName('notes.constructor')).toBeNull();
  });

  it('メディアタイプからも決める (パラメータと +json / +xml も見る)', () => {
    expect(languageFromMimeType('application/json; charset=utf-8')).toBe('json');
    expect(languageFromMimeType('application/vnd.api+json')).toBe('json');
    expect(languageFromMimeType('image/svg+xml')).toBe('xml');
    expect(languageFromMimeType('text/plain')).toBeNull();
    expect(languageFromMimeType(undefined)).toBeNull();
  });

  it('中身から推測する', () => {
    expect(guessLanguage('{"id": 1, "name": "a"')).toBe('json');
    expect(guessLanguage('[\n  1,\n  2')).toBe('json');
    expect(guessLanguage('<?xml version="1.0"?>\n<root/>')).toBe('xml');
    expect(guessLanguage('#!/usr/bin/env bash\necho hi\n')).toBe('bash');
    expect(guessLanguage('FROM python:3.12\nRUN pip install -r requirements.txt\nCOPY . /app\n')).toBe(
      'dockerfile',
    );
    expect(guessLanguage('2026-10-10 12:00:01 INFO start\n2026-10-10 12:00:02 ERROR failed\n')).toBe('log');
    expect(guessLanguage('id\tname\tscore\n1\ta\t0.5\n2\tb\t0.7\n')).toBe('tsv');
    expect(guessLanguage('id,name,score\n1,"a, b",0.5\n2,c,0.7\n')).toBe('csv');
    expect(guessLanguage('[server]\nhost = "localhost"\nport = 8080\n')).toBe('toml');
    expect(guessLanguage('[server]\nhost = localhost\n; comment\n')).toBe('ini');
    expect(guessLanguage('[[tool.uv.index]]\nname = "internal"\nurl = "https://example.com"\n')).toBe('toml');
    expect(guessLanguage('# settings\nAPI_URL=https://example.com\nexport TOKEN=x\n')).toBe('properties');
    expect(guessLanguage('model:\n  name: base\n  layers: 12\ndata:\n  - train\n')).toBe('yaml');
    expect(guessLanguage('# Title\n\nSome text with a [link](https://example.com).\n')).toBe('markdown');
    expect(guessLanguage('import os\n\ndef main():\n    return 0\n')).toBe('python');
    expect(guessLanguage('SELECT id FROM runs WHERE score > 0.5;\n')).toBe('sql');
    expect(guessLanguage('ただの文章です。\n二行目です。\n')).toBe('plaintext');
    expect(guessLanguage('')).toBe('plaintext');
  });

  it('ファイル名、メディアタイプ、中身の順に決める', () => {
    expect(detectLanguage({ fileName: 'data.csv', mimeType: 'application/json', text: '{}' })).toBe('csv');
    expect(detectLanguage({ fileName: 'data', mimeType: 'application/json', text: 'a,b\n1,2\n' })).toBe('json');
    expect(detectLanguage({ fileName: 'data.txt', mimeType: 'text/plain', text: 'a,b\n1,2\n' })).toBe('csv');
  });

  it('選択肢の形式はどれも有効で、ほかの値は形式ではない', () => {
    expect(CODE_LANGUAGES.every((language) => isCodeLanguage(language.id))).toBe(true);
    expect(isCodeLanguage('javascript')).toBe(false);
    expect(isCodeLanguage(null)).toBe(false);
  });

  it('highlight.js の形式は hljs の class で色を付け、HTML を逃がす', () => {
    const html = highlightCode('{"key": "<b>", "n": 1, "ok": true}', 'json');
    expect(html).toContain('<span class="hljs-attr">&quot;key&quot;</span>');
    expect(html).toContain('<span class="hljs-number">1</span>');
    expect(html).toMatch(/<span class="hljs-literal">(<span class="hljs-keyword">)?true/);
    expect(html).toContain('&lt;b&gt;');
    expect(html).not.toContain('<b>');
  });

  it('CSV は列ごと、引用符の中の区切りは同じ列に入れる', () => {
    const html = highlightCode('a,"b,c",d\n1,2,3', 'csv');
    expect(html).toBe(
      '<span class="code-column-0">a</span>,<span class="code-column-1">&quot;b,c&quot;</span>,' +
        '<span class="code-column-2">d</span>\n' +
        '<span class="code-column-0">1</span>,<span class="code-column-1">2</span>,<span class="code-column-2">3</span>',
    );
  });

  it('ログは行頭の時刻とレベルに色を付け、残りは逃がすだけ', () => {
    const html = highlightCode('2026-10-10 12:00:00 ERROR <oops>\nplain line', 'log');
    expect(html).toBe(
      '<span class="code-log-time">2026-10-10 12:00:00</span> ' +
        '<span class="code-log-level code-log-error">ERROR</span> &lt;oops&gt;\nplain line',
    );
  });

  it('ログのレベルは大文字か、括弧や level= の中のものだけで、本文の error には付けない', () => {
    expect(highlightCode('12:00:01 retrying after error', 'log')).toBe(
      '<span class="code-log-time">12:00:01</span> retrying after error',
    );
    expect(highlightCode('[info] ready', 'log')).toBe('<span class="code-log-level code-log-info">[info]</span> ready');
    expect(highlightCode('ts=1 level=warn msg=slow', 'log')).toBe(
      'ts=1 <span class="code-log-level code-log-warning">level=warn</span> msg=slow',
    );
  });

  it('上限を超えた分は色を付けずに逃がすだけ', () => {
    const text = `${'a'.repeat(HIGHLIGHT_MAX_CHARS)}<tail>`;
    const html = highlightCode(text, 'plaintext');
    expect(html.endsWith('&lt;tail&gt;')).toBe(true);
    expect(highlightCode(`${'1,'.repeat(HIGHLIGHT_MAX_CHARS / 2)}<x>`, 'csv').endsWith('&lt;x&gt;')).toBe(true);
    // A line break within the limit ends the colored part, so no line is colored only halfway.
    const lines = `a,b\n${'c'.repeat(HIGHLIGHT_MAX_CHARS)}`;
    expect(highlightCode(lines, 'csv')).toBe(
      `<span class="code-column-0">a</span>,<span class="code-column-1">b</span>\n${'c'.repeat(HIGHLIGHT_MAX_CHARS)}`,
    );
  });
});
