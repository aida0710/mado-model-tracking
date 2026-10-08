import { describe, expect, it } from 'vitest';
import { artifactBrowserPanes } from './artifactBrowserPanes';

describe('artifactBrowserPanes', () => {
  it('広い幅では一覧とプレビューを並べ、戻る操作は出さない', () => {
    expect(artifactBrowserPanes({ isNarrow: false, hasChosenFile: false })).toEqual({
      showList: true,
      showPreview: true,
      showBackToList: false,
    });
    expect(artifactBrowserPanes({ isNarrow: false, hasChosenFile: true }).showList).toBe(true);
  });

  it('狭い幅でファイルを選ぶ前は、パンくずと一覧だけを出す', () => {
    expect(artifactBrowserPanes({ isNarrow: true, hasChosenFile: false })).toEqual({
      showList: true,
      showPreview: false,
      showBackToList: false,
    });
  });

  it('狭い幅でファイルを選ぶと、一覧の代わりにプレビューと一覧へ戻る操作を出す', () => {
    expect(artifactBrowserPanes({ isNarrow: true, hasChosenFile: true })).toEqual({
      showList: false,
      showPreview: true,
      showBackToList: true,
    });
  });
});
