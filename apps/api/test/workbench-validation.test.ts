import { describe, expect, it } from 'vitest';
import {
  codeSourceSchema,
  isGitSourceUrl,
  MAX_CODE_TEXT_BYTES,
  repositoryFilesSchema,
} from '../src/domain/codeSourceValidation.js';
import {
  codeVersionSchema,
  pluginPatchSchema,
  runCreateSchema,
  targetPatchSchema,
} from '../src/domain/validation.js';
import { taskPatchSchema } from '../src/domain/experimentTaskValidation.js';
import { loadConfig } from '../src/config.js';

const version = {
  version: 'v1',
  source: { kind: 'inline', files: { 'main.py': 'pass' } },
  entrypoint: ['python', 'main.py'],
  supportedModelFamilies: ['fixture'],
  taskTypes: ['training'],
};
const gitSource = { kind: 'git', url: 'https://example.test/code.git', commit: 'a'.repeat(40) };

describe('コード編集・workbench入力検証', () => {
  it('Gitの固定commitに編集と削除の差分を登録できる', () => {
    expect(
      codeSourceSchema.parse({
        ...gitSource,
        files: { 'new.py': 'pass' },
        deletedFiles: ['old.py'],
      }),
    ).toMatchObject({
      files: { 'new.py': 'pass' },
      deletedFiles: ['old.py'],
    });
    expect(codeVersionSchema.parse(version).testEntrypoint).toEqual([]);
    expect(
      codeVersionSchema.parse({ ...version, testEntrypoint: ['python', '-m', 'pytest'] })
        .testEntrypoint,
    ).toEqual(['python', '-m', 'pytest']);
  });

  it.each([
    '../escape',
    '/absolute',
    'folder/../escape',
    '.git/config',
    'folder/.GIT/HEAD',
    'C:/file',
    'folder\\file',
    'folder//file',
    'file\0name',
    'file\nname',
  ])('unsafeなコードパス%sを拒否する', (path) => {
    for (const source of [
      { kind: 'inline', files: { [path]: 'pass' } },
      { ...gitSource, files: { [path]: 'pass' } },
      { ...gitSource, deletedFiles: [path] },
    ])
      expect(codeSourceSchema.safeParse(source).success).toBe(false);
  });

  it('同じパスの編集・削除と重複削除を拒否する', () => {
    expect(
      codeSourceSchema.safeParse({
        ...gitSource,
        files: { 'main.py': 'pass' },
        deletedFiles: ['main.py'],
      }).success,
    ).toBe(false);
    expect(
      codeSourceSchema.safeParse({ ...gitSource, deletedFiles: ['main.py', 'main.py'] }).success,
    ).toBe(false);
  });

  it.each(['inline', 'git'])('%sの編集ファイル同士の祖先・子孫の衝突を拒否する', (kind) => {
    expect(
      codeSourceSchema.safeParse({
        ...(kind === 'git' ? gitSource : { kind }),
        files: { 'folder/main.py': 'pass', 'folder-other.py': 'pass', folder: 'pass' },
      }).success,
    ).toBe(false);
  });

  it.each([
    {
      conflict: '編集した子孫と削除した祖先',
      files: { 'folder/new.py': 'pass' },
      deletedFiles: ['folder'],
    },
    {
      conflict: '編集した祖先と削除した子孫',
      files: { folder: 'pass' },
      deletedFiles: ['folder/old.py'],
    },
    {
      conflict: '削除した祖先と子孫',
      deletedFiles: ['folder', 'folder/old.py'],
    },
    {
      conflict: '逆順に削除した子孫と祖先',
      deletedFiles: ['folder/old.py', 'folder'],
    },
  ])('$conflictの衝突を拒否する', ({ conflict: _conflict, ...overlay }) => {
    expect(codeSourceSchema.safeParse({ ...gitSource, ...overlay }).success).toBe(false);
  });

  it('同じディレクトリの別ファイルと区切りのない共通prefixは編集・削除できる', () => {
    const source = {
      ...gitSource,
      files: { folder: 'pass', 'folder-name/new.py': 'pass', 'nested/new.py': 'pass' },
      deletedFiles: ['folder-other', 'folder-name/old.py', 'nested/old.py'],
    };
    expect(codeSourceSchema.parse(source)).toEqual(source);
  });

  it('編集テキストの合計bytesと引数のNULを拒否する', () => {
    expect(
      codeSourceSchema.safeParse({
        ...gitSource,
        files: {
          'first.py': 'a'.repeat(MAX_CODE_TEXT_BYTES / 2 + 1),
          'second.py': 'a'.repeat(MAX_CODE_TEXT_BYTES / 2 + 1),
        },
      }).success,
    ).toBe(false);
    expect(
      codeVersionSchema.safeParse({ ...version, testEntrypoint: ['python', 'test\0.py'] }).success,
    ).toBe(false);
  });

  it.each([
    'file:///tmp/repo',
    'http://example.test/repo',
    'https://user:password@example.test/repo',
    'https://user@example.test/repo',
    'ssh://git:password@example.test/repo',
    'https://example.test/repo\n',
    'https://example.test/repo?secret=value',
  ])('不正なrepository URL%sを拒否する', (url) => {
    expect(isGitSourceUrl(url)).toBe(false);
    expect(repositoryFilesSchema.safeParse({ url, commit: gitSource.commit }).success).toBe(false);
  });

  it('HTTPS/SSHだけを受け付け、branchや短いcommitを拒否する', () => {
    for (const url of [
      'https://example.test/repo.git',
      'ssh://git@example.test/repo.git',
      'git@example.test:repo.git',
    ])
      expect(isGitSourceUrl(url)).toBe(true);
    for (const commit of ['main', 'abcd', '--help'])
      expect(repositoryFilesSchema.safeParse({ url: gitSource.url, commit }).success).toBe(false);
  });

  it('PATCHに省略した既定値を補わず、固定参照の変更fieldを拒否する', () => {
    expect(targetPatchSchema.parse({ name: 'Renamed' })).toEqual({ name: 'Renamed' });
    expect(pluginPatchSchema.parse({ name: 'Renamed' })).toEqual({ name: 'Renamed' });
    expect(
      taskPatchSchema.safeParse({
        expectedRevision: 1,
        experimentId: '00000000-0000-4000-8000-000000000000',
      }).success,
    ).toBe(false);
    expect(
      runCreateSchema.safeParse({
        experimentId: '00000000-0000-4000-8000-000000000000',
        name: 'Test',
        kind: 'training',
        taskId: '00000000-0000-4000-8000-000000000000',
      }).success,
    ).toBe(false);
  });

  it('repository SSH鍵とknown_hostsはoperatorの両方の絶対パスを要求する', () => {
    const environment = {
      AUTH_MODE: 'development',
      MMT_DATABASE_URL: 'postgresql://test@localhost/mmt_test',
    };
    expect(loadConfig(environment).repositorySsh).toBeNull();
    expect(() => loadConfig({ ...environment, MMT_GIT_SSH_KEY_PATH: '/fixture/key' })).toThrow(
      'must be set together',
    );
    expect(() =>
      loadConfig({
        ...environment,
        MMT_GIT_SSH_KEY_PATH: 'relative',
        MMT_GIT_KNOWN_HOSTS_PATH: '/fixture/hosts',
      }),
    ).toThrow('Invalid configuration');
    expect(
      loadConfig({
        ...environment,
        MMT_GIT_SSH_KEY_PATH: '/fixture/key',
        MMT_GIT_KNOWN_HOSTS_PATH: '/fixture/hosts',
      }).repositorySsh,
    ).toEqual({ keyPath: '/fixture/key', knownHostsPath: '/fixture/hosts' });
  });
});
