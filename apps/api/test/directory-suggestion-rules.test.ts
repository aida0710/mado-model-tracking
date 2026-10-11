import { describe, expect, it } from 'vitest';
import {
  compareDirectoryNames,
  isSuggestedName,
  planDirectorySuggestions,
} from '../src/domain/directorySuggestionRules.js';

const WORKING_DIRECTORY = '/srv/mmt';

describe('保存先ディレクトリ候補の規則', () => {
  it('"/"で終わる入力はそのディレクトリの子を、名前の制限なしで候補にする', () => {
    expect(planDirectorySuggestions('/data/', WORKING_DIRECTORY)).toEqual({
      resolvedPath: '/data',
      listedDirectory: '/data',
      namePrefix: '',
      includesHidden: false,
    });
    expect(planDirectorySuggestions('/', WORKING_DIRECTORY)).toMatchObject({
      resolvedPath: '/',
      listedDirectory: '/',
      namePrefix: '',
    });
  });

  it('"/"で終わらない入力は親ディレクトリの子のうち最後の要素で始まるものを候補にする', () => {
    expect(planDirectorySuggestions('/data/exp', WORKING_DIRECTORY)).toEqual({
      resolvedPath: '/data/exp',
      listedDirectory: '/data',
      namePrefix: 'exp',
      includesHidden: false,
    });
  });

  it('相対パスはAPIの作業ディレクトリから解決する', () => {
    expect(planDirectorySuggestions('var/art', WORKING_DIRECTORY)).toEqual({
      resolvedPath: '/srv/mmt/var/art',
      listedDirectory: '/srv/mmt/var',
      namePrefix: 'art',
      includesHidden: false,
    });
    expect(planDirectorySuggestions('var', WORKING_DIRECTORY)).toMatchObject({
      listedDirectory: '/srv/mmt',
      namePrefix: 'var',
    });
    expect(planDirectorySuggestions('./', WORKING_DIRECTORY)).toMatchObject({
      resolvedPath: '/srv/mmt',
      listedDirectory: '/srv/mmt',
      namePrefix: '',
    });
  });

  it('隠しディレクトリは最後の要素が"."で始まるときだけ候補にする', () => {
    const children = planDirectorySuggestions('/home/user/', WORKING_DIRECTORY);
    expect(isSuggestedName('.cache', children)).toBe(false);
    expect(isSuggestedName('projects', children)).toBe(true);
    const hidden = planDirectorySuggestions('/home/user/.c', WORKING_DIRECTORY);
    expect(hidden.includesHidden).toBe(true);
    expect(isSuggestedName('.cache', hidden)).toBe(true);
    expect(isSuggestedName('.config', hidden)).toBe(true);
    expect(isSuggestedName('.local', hidden)).toBe(false);
  });

  it('接頭辞は大文字小文字を区別して比べ、並びは名前のcode point順', () => {
    const plan = planDirectorySuggestions('/data/Ex', WORKING_DIRECTORY);
    expect(isSuggestedName('Experiments', plan)).toBe(true);
    expect(isSuggestedName('experiments', plan)).toBe(false);
    expect(['b', 'B', 'a', '_', 'A'].sort(compareDirectoryNames)).toEqual([
      'A',
      'B',
      '_',
      'a',
      'b',
    ]);
  });
});
