import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BREAKPOINT_PX, narrowerThan } from './breakpoints';

const stylesDirectory = new URL('../styles/', import.meta.url);
const readStylesheet = (name: string) => readFileSync(new URL(name, stylesDirectory), 'utf8');
const stylesheetNames = readdirSync(stylesDirectory).filter((name) => name.endsWith('.css'));

describe('width breakpoints', () => {
  it('breakpoints.css の --bp-* は lib/breakpoints.ts と同じ値になる', () => {
    const css = readStylesheet('breakpoints.css');
    for (const [name, px] of Object.entries(BREAKPOINT_PX))
      expect(css).toContain(`--bp-${name}: ${px}px;`);
  });

  it('どのスタイルシートのメディアクエリも共通の切り替え点だけを使う', () => {
    const allowed = new Set(Object.values(BREAKPOINT_PX).map((px) => `(width < ${px}px)`));
    const offending = stylesheetNames.flatMap((name) =>
      [...readStylesheet(name).matchAll(/@media\s+([^{]*?)\s*\{/g)]
        .map((match) => match[1]!)
        .filter((query) => !query.startsWith('(prefers-') && !allowed.has(query))
        .map((query) => `${name}: ${query}`),
    );
    expect(offending).toEqual([]);
  });

  it('narrowerThan は切り替え点より狭い間だけ一致するクエリを返す', () => {
    expect(narrowerThan('sm')).toBe('(width < 640px)');
    expect(narrowerThan('lg')).toBe('(width < 1200px)');
  });
});
