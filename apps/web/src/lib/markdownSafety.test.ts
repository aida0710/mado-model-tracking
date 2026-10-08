import { describe, expect, it } from 'vitest';
import {
  formatUrlForDisplay,
  getMarkdownImageDisplay,
  getSafeLinkHref,
  isExternalLink,
} from './markdownSafety';

const ORIGIN = 'https://tracking.example.com';

describe('Markdownのリンク先', () => {
  it('javascript:とdata:とvbscript:のリンクは無効にする', () => {
    expect(getSafeLinkHref('javascript:alert(1)')).toBeNull();
    expect(getSafeLinkHref('JavaScript:alert(1)')).toBeNull();
    expect(getSafeLinkHref('data:text/html;base64,PHNjcmlwdD4=')).toBeNull();
    expect(getSafeLinkHref('vbscript:msgbox(1)')).toBeNull();
    expect(getSafeLinkHref('file:///etc/passwd')).toBeNull();
  });

  it('スキームの途中に空白や制御文字を挟んだjavascript:も無効にする', () => {
    expect(getSafeLinkHref('java\tscript:alert(1)')).toBeNull();
    expect(getSafeLinkHref(' \njavascript:alert(1)')).toBeNull();
    expect(getSafeLinkHref('java\u0000script:alert(1)')).toBeNull();
  });

  it('https・http・mailtoと相対パスはそのままリンクにする', () => {
    expect(getSafeLinkHref('https://example.com/a?b=1')).toBe('https://example.com/a?b=1');
    expect(getSafeLinkHref('http://example.com')).toBe('http://example.com');
    expect(getSafeLinkHref('mailto:ml@example.com')).toBe('mailto:ml@example.com');
    expect(getSafeLinkHref('/projects/p/runs/r')).toBe('/projects/p/runs/r');
    expect(getSafeLinkHref('../runs/r?tab=metrics')).toBe('../runs/r?tab=metrics');
    expect(getSafeLinkHref('#結果')).toBe('#結果');
  });

  it('空のURLはリンクにしない', () => {
    expect(getSafeLinkHref('  ')).toBeNull();
  });

  it('文字として表示するURLは、パーサーが付けたパーセント符号化を戻す', () => {
    expect(formatUrlForDisplay('javascript:alert(%22x%22)')).toBe('javascript:alert("x")');
    expect(formatUrlForDisplay('javascript:%E0%A4%A')).toBe('javascript:%E0%A4%A');
  });

  it('別のoriginへのリンクだけを外部リンクとして扱う', () => {
    expect(isExternalLink('https://example.com', ORIGIN)).toBe(true);
    expect(isExternalLink('//example.com/x', ORIGIN)).toBe(true);
    expect(isExternalLink('/projects/p', ORIGIN)).toBe(false);
    expect(isExternalLink(`${ORIGIN}/projects/p`, ORIGIN)).toBe(false);
    expect(isExternalLink('mailto:ml@example.com', ORIGIN)).toBe(false);
  });
});

describe('Markdownの画像', () => {
  it('同じoriginのArtifact contentだけを画像として表示する', () => {
    expect(getMarkdownImageDisplay('/api/projects/p1/artifacts/a1/content', ORIGIN)).toEqual({
      kind: 'image',
      src: '/api/projects/p1/artifacts/a1/content',
    });
    expect(
      getMarkdownImageDisplay(`${ORIGIN}/api/projects/p1/artifacts/a1/content?download=0`, ORIGIN),
    ).toEqual({ kind: 'image', src: '/api/projects/p1/artifacts/a1/content?download=0' });
  });

  it('外部の画像は読み込まずにリンクにする', () => {
    expect(getMarkdownImageDisplay('https://tracker.example.net/pixel.png', ORIGIN)).toEqual({
      kind: 'link',
      href: 'https://tracker.example.net/pixel.png',
    });
    expect(
      getMarkdownImageDisplay('https://evil.example.net/api/projects/p1/artifacts/a1/content', ORIGIN),
    ).toEqual({
      kind: 'link',
      href: 'https://evil.example.net/api/projects/p1/artifacts/a1/content',
    });
  });

  it('同じoriginでもArtifact content以外のパスは画像にしない', () => {
    expect(getMarkdownImageDisplay('/api/auth/logout', ORIGIN)).toEqual({
      kind: 'link',
      href: '/api/auth/logout',
    });
    expect(
      getMarkdownImageDisplay('/api/projects/p1/artifacts/a1/../../../auth/me/content', ORIGIN).kind,
    ).toBe('link');
  });

  it('javascript:やdata:の画像はリンクにもせず文字として残す', () => {
    expect(getMarkdownImageDisplay('javascript:alert(1)', ORIGIN)).toEqual({ kind: 'text' });
    expect(getMarkdownImageDisplay('data:image/png;base64,iVBORw0KGgo=', ORIGIN)).toEqual({
      kind: 'text',
    });
  });
});
