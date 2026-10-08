import { afterEach, describe, expect, it, vi } from 'vitest';
import { metricSeriesApi } from './metricSeries';

afterEach(() => vi.unstubAllGlobals());

function stubFetch(body: unknown, status = 200) {
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status }));
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

describe('メトリクス系列のAPI', () => {
  it('系列の取得はProjectのmetrics/seriesへx範囲を含むbodyをPOSTする', async () => {
    const fetch = stubFetch({ series: [] });
    const controller = new AbortController();
    const body = {
      runIds: ['run/1', 'run-2'],
      keys: ['loss'],
      xAxis: { kind: 'step' as const },
      maxPoints: 1000,
      xRange: { min: 100, max: 200 },
    };
    expect(await metricSeriesApi.series('project/1', body, controller.signal)).toEqual({
      series: [],
    });
    expect(fetch).toHaveBeenCalledWith('/api/projects/project%2F1/metrics/series', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
      credentials: 'include',
    });
  });

  it('グループの取得は検索条件とgroupByをmetrics/groupsへPOSTする', async () => {
    const fetch = stubFetch({ groups: [] });
    const body = {
      search: { filter: 'params.lr > 0.01' },
      groupBy: { kind: 'param' as const, key: 'lr' },
      keys: ['loss'],
      xAxis: { kind: 'metric' as const, metricKey: 'epoch' },
    };
    await metricSeriesApi.groups('project', body);
    expect(fetch).toHaveBeenCalledWith('/api/projects/project/metrics/groups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: undefined,
      credentials: 'include',
    });
  });

  it('再開イベントはRun IDをencodeしてGETする', async () => {
    const fetch = stubFetch({ items: [], segments: [] });
    expect(await metricSeriesApi.resumeEvents('project', 'run/1')).toEqual({
      items: [],
      segments: [],
    });
    expect(fetch).toHaveBeenCalledWith('/api/projects/project/runs/run%2F1/resume-events', {
      signal: undefined,
      credentials: 'include',
    });
  });

  it('契約と違う形の応答は応答形式のエラーにする', async () => {
    stubFetch({ series: null });
    await expect(
      metricSeriesApi.series('project', { runIds: ['a'], keys: ['loss'], xAxis: { kind: 'step' } }),
    ).rejects.toMatchObject({ code: 'invalid_response' });
  });
});
