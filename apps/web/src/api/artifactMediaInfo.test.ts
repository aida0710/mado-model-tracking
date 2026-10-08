import { ARTIFACT_MEDIA_INFO_BATCH_LIMIT } from '@mmt/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { artifactMediaInfoApi } from './artifactMediaInfo';

afterEach(() => vi.unstubAllGlobals());
describe('Artifactのmedia情報', () => {
  it('media情報が無い404はnullにし、それ以外の失敗はそのまま投げる', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'x', code: 'not_found' }), { status: 404 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'x', code: 'project_forbidden' }), { status: 403 }));
    vi.stubGlobal('fetch', fetch);
    await expect(artifactMediaInfoApi.get('project', 'artifact')).resolves.toBeNull();
    expect(fetch.mock.calls[0]?.[0]).toBe('/api/projects/project/artifacts/artifact/media-info');
    await expect(artifactMediaInfoApi.get('project', 'artifact')).rejects.toMatchObject({ status: 403 });
  });

  it('まとめ取得は重複を除き、APIの上限ごとに分けて送る', async () => {
    const fetch = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ items: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    const ids = Array.from({ length: ARTIFACT_MEDIA_INFO_BATCH_LIMIT + 1 }, (_, index) => `a${index}`);
    await artifactMediaInfoApi.list('project', [...ids, 'a0']);
    expect(fetch).toHaveBeenCalledTimes(2);
    const sentIds = fetch.mock.calls.map(([url]) => new URL(url as string, 'http://x').searchParams.get('artifactIds')!.split(','));
    expect(sentIds.map((chunk) => chunk.length)).toEqual([ARTIFACT_MEDIA_INFO_BATCH_LIMIT, 1]);
  });
});
