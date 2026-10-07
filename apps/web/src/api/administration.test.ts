import { afterEach, describe, expect, it, vi } from 'vitest';
import { administrationApi } from './administration';

afterEach(() => vi.unstubAllGlobals());

describe('pluginMetrics', () => {
  it('認証cookieと中断signalを渡し、空のprometheusもそのまま返す', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ prometheus: '' }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    const controller = new AbortController();
    expect(await administrationApi.pluginMetrics('project', 'plugin', controller.signal)).toBe('');
    expect(fetch).toHaveBeenCalledWith('/api/projects/project/plugins/plugin/metrics', {
      credentials: 'include',
      signal: controller.signal,
    });
  });

  it('prometheusがない成功応答を空データへ補完せずエラーにする', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })));
    await expect(administrationApi.pluginMetrics('project', 'plugin')).rejects.toThrow();
  });
});
