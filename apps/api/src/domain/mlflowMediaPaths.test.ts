import { describe, expect, it } from 'vitest';
import {
  isMlflowPercentImagePath,
  parseLoggedTablePaths,
  parseMlflowImagePath,
} from './mlflowMediaPaths.js';

// File names as MLflow 3.0.0 and 3.17.0 write them (the uuid of 3.0.0 starts with g-z).
const V3_0_IMAGE = 'images/loss%step%12%timestamp%1728370000123%h1b2c3d4-0000-4000-8000-000000000001.png';
const V3_17_IMAGE = 'images/loss+step+12+timestamp+1728370000123+a1b2c3d4-0000-4000-8000-000000000001.png';

describe('parseMlflowImagePath', () => {
  it('MLflow 3.0の%区切りからkey・step・timestampを読む', () => {
    expect(parseMlflowImagePath(V3_0_IMAGE)).toEqual({
      key: 'loss',
      step: 12,
      timestamp: 1728370000123,
      separator: '%',
      fileId: 'h1b2c3d4-0000-4000-8000-000000000001',
      compressed: false,
      imagePath: V3_0_IMAGE,
      compressedPath: V3_0_IMAGE.replace('.png', '%compressed.webp'),
    });
  });

  it('MLflow 3.17の+区切りからkey・step・timestampを読む', () => {
    expect(parseMlflowImagePath(V3_17_IMAGE)).toMatchObject({
      key: 'loss',
      step: 12,
      timestamp: 1728370000123,
      compressed: false,
    });
  });

  it('compressed.webpは同じ呼び出しの本体の画像pathを返す', () => {
    const compressed = V3_17_IMAGE.replace('.png', '+compressed.webp');
    expect(parseMlflowImagePath(compressed)).toMatchObject({
      key: 'loss',
      step: 12,
      compressed: true,
      imagePath: V3_17_IMAGE,
      compressedPath: compressed,
    });
    expect(parseMlflowImagePath(V3_0_IMAGE.replace('.png', '%compressed.webp'))).toMatchObject({
      compressed: true,
      imagePath: V3_0_IMAGE,
    });
  });

  it('keyの/は3.17の~と3.0の#から戻す', () => {
    expect(
      parseMlflowImagePath('images/eval~samples~mel+step+0+timestamp+1+b0000000-0000-4000-8000-000000000000.png')?.key,
    ).toBe('eval/samples/mel');
    expect(
      parseMlflowImagePath('images/eval#mel%step%3%timestamp%1%g0000000-0000-4000-8000-000000000000.png')?.key,
    ).toBe('eval/mel');
  });

  it('keyに空白と.を含んでもよい', () => {
    expect(
      parseMlflowImagePath('images/val set.v2+step+1+timestamp+1+b0000000-0000-4000-8000-000000000000.png')?.key,
    ).toBe('val set.v2');
  });

  it.each([
    ['images/ 以外', 'figures/loss+step+1+timestamp+1+b0000000-0000-4000-8000-000000000000.png'],
    ['log_imageのartifact_file指定', 'images/gradient.png'],
    ['区切りが混ざったもの', 'images/loss+step%1+timestamp+1+b0000000-0000-4000-8000-000000000000.png'],
    ['stepが負', 'images/loss+step+-1+timestamp+1+b0000000-0000-4000-8000-000000000000.png'],
    ['本体がwebp', 'images/loss+step+1+timestamp+1+b0000000-0000-4000-8000-000000000000.webp'],
    ['compressedがpng', 'images/loss+step+1+timestamp+1+b0000000-0000-4000-8000-000000000000+compressed.png'],
    ['下の階層', 'images/sub/loss+step+1+timestamp+1+b0000000-0000-4000-8000-000000000000.png'],
  ])('%sはnull', (_label, path) => {
    expect(parseMlflowImagePath(path)).toBeNull();
  });
});

describe('parseLoggedTablePaths', () => {
  it('type=tableのpathだけを重複なしで返す', () => {
    expect(
      parseLoggedTablePaths(
        JSON.stringify([
          { path: 'tables/a.json', type: 'table' },
          { path: 'tables/a.json', type: 'table' },
          { path: 'images/x.png', type: 'image' },
          { path: '', type: 'table' },
          'broken',
        ]),
      ),
    ).toEqual(['tables/a.json']);
  });

  it('壊れたtagは空', () => {
    expect(parseLoggedTablePaths('{not json')).toEqual([]);
    expect(parseLoggedTablePaths('{"path": "a"}')).toEqual([]);
    expect(parseLoggedTablePaths(undefined)).toEqual([]);
  });
});

describe('isMlflowPercentImagePath', () => {
  it('MLflow 3.0の画像とcompressed.webpだけを認める', () => {
    expect(isMlflowPercentImagePath(V3_0_IMAGE)).toBe(true);
    expect(isMlflowPercentImagePath(V3_0_IMAGE.replace('.png', '%compressed.webp'))).toBe(true);
    expect(isMlflowPercentImagePath(V3_17_IMAGE)).toBe(false);
  });

  it('uuidが16進数で始まる名前や先頭0のstepは認めない', () => {
    expect(isMlflowPercentImagePath(V3_0_IMAGE.replace('%h1b2', '%2e2e'))).toBe(false);
    expect(isMlflowPercentImagePath(V3_0_IMAGE.replace('%step%12%', '%step%012%'))).toBe(false);
    expect(isMlflowPercentImagePath('images/%2e%2e%step%1%timestamp%1%g0.png')).toBe(false);
  });
});
