import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DirectorySuggestions } from '@mmt/contracts';
import { DIRECTORY_SUGGESTION_LIMIT } from '../src/services/storageDirectoryService.js';
import { createHarness, entity, login, request, testDatabaseUrl, type Harness } from './harness.js';

// The rootPath bound of storage backends (storageBackendValidation.ts).
const MAX_TYPED_PATH_LENGTH = 2000;

describe.skipIf(!testDatabaseUrl)('保存先ディレクトリの候補（独立PostgreSQL）', () => {
  let harness: Harness;
  let administrator: { cookie: string };
  let root: string;
  beforeAll(async () => {
    harness = await createHarness();
    administrator = await login(harness);
    root = await mkdtemp(path.join(tmpdir(), 'mmt-directory-suggestions-'));
    for (const name of ['alpha', 'alpine', 'beta', '.hidden', '.cache'])
      await mkdir(path.join(root, name));
    await writeFile(path.join(root, 'afile'), 'not a directory');
    await symlink(path.join(root, 'alpha'), path.join(root, 'alink'));
    await symlink(path.join(root, 'nowhere'), path.join(root, 'abroken'));
    await mkdir(path.join(root, 'many'));
    for (let index = 0; index <= DIRECTORY_SUGGESTION_LIMIT; index++)
      await mkdir(path.join(root, 'many', `run-${String(index).padStart(3, '0')}`));
  });
  afterAll(async () => {
    await harness?.close();
    if (root) await rm(root, { recursive: true, force: true });
  });

  function suggest(typedPath: string, cookie = administrator.cookie): Promise<Response> {
    return request(
      harness.app,
      `/api/admin/storage-directories?path=${encodeURIComponent(typedPath)}`,
      {
        cookie,
      },
    );
  }

  async function suggestions(typedPath: string): Promise<DirectorySuggestions> {
    return entity<DirectorySuggestions>(await suggest(typedPath), 200);
  }

  const at = (...names: string[]) => names.map((name) => path.join(root, name));

  it('"/"で終わる入力はそのディレクトリの子を、隠しディレクトリとファイルを除いて名前順に返す', async () => {
    expect(await suggestions(`${root}/`)).toEqual({
      resolvedPath: root,
      status: 'directory',
      // alink is a symlink to a directory; abroken leads nowhere and afile is a file.
      items: at('alink', 'alpha', 'alpine', 'beta', 'many'),
      truncated: false,
    });
  });

  it('"/"で終わらない入力は親ディレクトリの子のうち最後の要素で始まるものを返す', async () => {
    expect(await suggestions(path.join(root, 'alp'))).toEqual({
      resolvedPath: path.join(root, 'alp'),
      status: 'missing',
      items: at('alpha', 'alpine'),
      truncated: false,
    });
    expect((await suggestions(path.join(root, 'alpha'))).status).toBe('directory');
  });

  it('隠しディレクトリは最後の要素が"."で始まるときだけ返す', async () => {
    expect((await suggestions(`${root}/.`)).items).toEqual(at('.cache', '.hidden'));
    expect((await suggestions(path.join(root, '.h'))).items).toEqual(at('.hidden'));
  });

  it('相対パスはAPIの作業ディレクトリから解決する', async () => {
    const relative = `${path.relative(process.cwd(), root)}/`;
    expect(await suggestions(relative)).toMatchObject({
      resolvedPath: root,
      status: 'directory',
      items: at('alink', 'alpha', 'alpine', 'beta', 'many'),
    });
  });

  it('無いディレクトリ・ファイル・読めない場所はエラーにせず空の候補を返す', async () => {
    expect(await suggestions(path.join(root, 'missing', 'child', '/'))).toEqual({
      resolvedPath: path.join(root, 'missing', 'child'),
      status: 'missing',
      items: [],
      truncated: false,
    });
    expect(await suggestions(`${path.join(root, 'afile')}/`)).toEqual({
      resolvedPath: path.join(root, 'afile'),
      status: 'not_directory',
      items: [],
      truncated: false,
    });
  });

  it('候補が上限を超えると上限までを返してtruncatedにする', async () => {
    const many = await suggestions(path.join(root, 'many', 'run-'));
    expect(many.items).toHaveLength(DIRECTORY_SUGGESTION_LIMIT);
    expect(many.items[0]).toBe(path.join(root, 'many', 'run-000'));
    expect(many.truncated).toBe(true);
    const exact = await suggestions(path.join(root, 'many', 'run-00'));
    expect(exact).toMatchObject({ truncated: false });
    expect(exact.items).toHaveLength(10);
  });

  it('空・長すぎる・制御文字を含む入力は422で、全体管理者でなければ403', async () => {
    for (const typed of ['', `/${'a'.repeat(MAX_TYPED_PATH_LENGTH)}`, `${root}/\u0000`]) {
      const response = await suggest(typed);
      expect(response.status).toBe(422);
    }
    const outsider = await login(harness, 'outsider@localhost');
    const refused = await suggest(`${root}/`, outsider.cookie);
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { code: string }).code).toBe('admin_required');
  });
});
