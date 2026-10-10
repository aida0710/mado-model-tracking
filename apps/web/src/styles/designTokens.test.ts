import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const stylesDirectory = new URL('./', import.meta.url);
const stylesheetNames = readdirSync(stylesDirectory).filter((name) => name.endsWith('.css'));
const withoutComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');
const readStylesheet = (name: string) => withoutComments(readFileSync(new URL(name, stylesDirectory), 'utf8'));
const tokensCss = withoutComments(
  readFileSync(createRequire(import.meta.url).resolve('@mado/design-tokens/tokens.css'), 'utf8'),
);

// Custom properties a component sets inline (ChartPanelGrid sets the chart row height).
const PROPERTIES_SET_FROM_COMPONENTS = ['--chart-row-height'];
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
  it('領域のスタイルシートは色を値で書かず、@mado/design-tokens の変数を使う', () => {
    const offending = stylesheetNames.flatMap((name) =>
      declarations(readStylesheet(name))
        .filter(({ value }) => LITERAL_COLOR.test(value))
        .map(({ property, value }) => `${name}: ${property}: ${value}`),
    );
    expect(offending).toEqual([]);
  });

  it('スタイルシートが参照する変数はどれも定義されている', () => {
    const defined = new Set([
      ...definedProperties(tokensCss),
      ...stylesheetNames.flatMap((name) => definedProperties(readStylesheet(name))),
      ...PROPERTIES_SET_FROM_COMPONENTS,
    ]);
    const undefinedReferences = stylesheetNames.flatMap((name) =>
      [...readStylesheet(name).matchAll(/var\((--[\w-]+)/g)]
        .map((match) => match[1]!)
        .filter((property) => !defined.has(property))
        .map((property) => `${name}: ${property}`),
    );
    expect(undefinedReferences).toEqual([]);
  });

  it('ダークテーマはライトにある変数だけを上書きする', () => {
    const light = new Set(definedProperties(ruleBody(tokensCss, ':root')));
    const dark = definedProperties(ruleBody(tokensCss, ":root[data-theme='dark']"));
    expect(dark.length).toBeGreaterThan(0);
    expect(dark.filter((property) => !light.has(property))).toEqual([]);
  });
});
