import { describe, expect, it } from 'vitest';
import type { DirectorySuggestions } from '@mmt/contracts';
import { toDirectoryFieldSuggestions } from './storageDirectorySuggestions';
import { text, textTemplates } from '../i18n/catalog';

const directories = (overrides: Partial<DirectorySuggestions>): DirectorySuggestions => ({
  resolvedPath: '/data/mm',
  status: 'missing',
  items: [],
  truncated: false,
  ...overrides,
});

describe('toDirectoryFieldSuggestions', () => {
  it('入力途中の名前を補う候補があれば、無いパスでも注記を出さない', () => {
    expect(
      toDirectoryFieldSuggestions(directories({ items: ['/data/mmt', '/data/mmt-old'] })),
    ).toEqual({ items: ['/data/mmt', '/data/mmt-old'], note: undefined });
  });

  it('存在せず補う候補も無いパスは、あとで作成されることを注記する', () => {
    expect(toDirectoryFieldSuggestions(directories({})).note).toBe(
      textTemplates.storageDirectoryMissing('/data/mm'),
    );
  });

  it('ファイルを指すパスは、候補があってもディレクトリでないことを注記する', () => {
    const suggestions = toDirectoryFieldSuggestions(
      directories({ status: 'not_directory', resolvedPath: '/data/mmt.tar', items: ['/data/mmt.tar.d'] }),
    );
    expect(suggestions.note).toBe(textTemplates.storageDirectoryNotDirectory('/data/mmt.tar'));
  });

  it('候補が上限で切られたときは、続けて入力するよう注記する', () => {
    expect(
      toDirectoryFieldSuggestions(
        directories({ status: 'directory', resolvedPath: '/data', items: ['/data/a'], truncated: true }),
      ).note,
    ).toBe(text.storageDirectoryTruncated);
  });

  it('あるディレクトリで候補が収まっていれば注記は無い', () => {
    expect(
      toDirectoryFieldSuggestions(directories({ status: 'directory', items: ['/data/a/b'] })).note,
    ).toBeUndefined();
  });
});
