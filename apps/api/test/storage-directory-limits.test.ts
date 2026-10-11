import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Principal } from '../src/auth/principal.js';
import { StorageDirectoryService } from '../src/services/storageDirectoryService.js';

// Only what requireGlobalAdmin reads: a global administrator's browser session.
const administrator = {
  user: { id: '00000000-0000-4000-8000-000000000001', isAdmin: true },
  method: 'session',
  token: null,
} as unknown as Principal;

describe('保存先ディレクトリの候補の読み取りの上限と時間切れ', () => {
  let root: string;
  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'mmt-directory-limits-'));
    for (const name of ['data-a', 'data-b', 'data-c', 'data-d']) await mkdir(path.join(root, name));
  });
  afterAll(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('読む件数の上限を超えるディレクトリは、読んだ分だけを返してtruncatedにする', async () => {
    const service = new StorageDirectoryService({ scan: 2, timeoutMs: 10_000 });
    const found = await service.suggest(administrator, `${root}/`);
    expect(found.status).toBe('directory');
    expect(found.items).toHaveLength(2);
    expect(found.truncated).toBe(true);
  });

  it('上限に収まるディレクトリはすべて返し、truncatedにしない', async () => {
    const service = new StorageDirectoryService({ scan: 100, timeoutMs: 10_000 });
    const found = await service.suggest(administrator, `${root}/`);
    expect(found.items.map((item) => path.basename(item))).toEqual([
      'data-a',
      'data-b',
      'data-c',
      'data-d',
    ]);
    expect(found.truncated).toBe(false);
  });

  it('読み取りが時間内に終わらなければ、候補なしのunavailableを返して待ち続けない', async () => {
    const neverAnswers = () => new Promise<never>(() => {});
    const service = new StorageDirectoryService({ scan: 100, timeoutMs: 20 }, neverAnswers);
    await expect(service.suggest(administrator, `${root}/`)).resolves.toEqual({
      resolvedPath: root,
      status: 'unavailable',
      items: [],
      truncated: true,
    });
  });
});
