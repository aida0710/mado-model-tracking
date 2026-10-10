import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { BREAKPOINT_PX } from '../lib/breakpoints';

const stylesDirectory = new URL('./', import.meta.url);
const stylesheetNames = readdirSync(stylesDirectory).filter((name) => name.endsWith('.css'));
const withoutComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');
const readStylesheet = (name: string) => withoutComments(readFileSync(new URL(name, stylesDirectory), 'utf8'));
const resolvePackageFile = createRequire(import.meta.url).resolve;
const readPackageFile = (name: string) =>
  withoutComments(readFileSync(resolvePackageFile(`@mado/design-tokens/${name}`), 'utf8'));
const tokensCss = readPackageFile('tokens.css');
// The shared element defaults, components, app frame and code view, which use the tokens like this
// app does.
const sharedStylesheets = ['base.css', 'components.css', 'shell.css', 'code.css'].map((name) => ({
  name: `@mado/design-tokens/${name}`,
  css: readPackageFile(name),
}));
const appStylesheets = stylesheetNames.map((name) => ({ name, css: readStylesheet(name) }));
const allStylesheets = [...sharedStylesheets, ...appStylesheets];

// Custom properties a component sets inline: ChartPanelGrid the chart row height, the app shells
// the sidebar width the user dragged.
const PROPERTIES_SET_FROM_COMPONENTS = ['--chart-row-height', '--navigation-width'];
const LITERAL_COLOR =
  /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(|(?<![\w-])(?:white|black)(?![\w-])/i;

const declarations = (css: string) =>
  [...css.matchAll(/((?:--)?[a-z][\w-]*)\s*:\s*([^;{}]+);/gi)].map((match) => ({
    property: match[1]!,
    value: match[2]!.trim(),
  }));
const definedProperties = (css: string) =>
  declarations(css)
    .map(({ property }) => property)
    .filter((property) => property.startsWith('--'));
const ruleBody = (css: string, selector: string) => {
  const start = css.indexOf(`${selector} {`);
  return start < 0 ? '' : css.slice(start, css.indexOf('}', start));
};

describe('design tokens', () => {
  it('共通の部品とこのアプリのスタイルシートは色を値で書かず、@mado/design-tokens の変数を使う', () => {
    const offending = allStylesheets.flatMap(({ name, css }) =>
      declarations(css)
        .filter(({ value }) => LITERAL_COLOR.test(value))
        .map(({ property, value }) => `${name}: ${property}: ${value}`),
    );
    expect(offending).toEqual([]);
  });

  it('スタイルシートが参照する変数はどれも定義されている', () => {
    const defined = new Set([
      ...definedProperties(tokensCss),
      ...allStylesheets.flatMap(({ css }) => definedProperties(css)),
      ...PROPERTIES_SET_FROM_COMPONENTS,
    ]);
    const undefinedReferences = allStylesheets.flatMap(({ name, css }) =>
      [...css.matchAll(/var\((--[\w-]+)/g)]
        .map((match) => match[1]!)
        .filter((property) => !defined.has(property))
        .map((property) => `${name}: ${property}`),
    );
    expect(undefinedReferences).toEqual([]);
  });

  it('共通の部品のメディアクエリもこのアプリと同じ切り替え点だけを使う', () => {
    const allowed = new Set(Object.values(BREAKPOINT_PX).map((px) => `(width < ${px}px)`));
    const offending = sharedStylesheets.flatMap(({ name, css }) =>
      [...css.matchAll(/@media\s+([^{]*?)\s*\{/g)]
        .map((match) => match[1]!)
        .filter((query) => !query.startsWith('(prefers-') && !allowed.has(query))
        .map((query) => `${name}: ${query}`),
    );
    expect(offending).toEqual([]);
  });

  it('ダークテーマはライトにある変数だけを上書きする', () => {
    const light = new Set(definedProperties(ruleBody(tokensCss, ':root')));
    const dark = definedProperties(ruleBody(tokensCss, ":root[data-theme='dark']"));
    expect(dark.length).toBeGreaterThan(0);
    expect(dark.filter((property) => !light.has(property))).toEqual([]);
  });
});
