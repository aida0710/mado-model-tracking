import { afterEach, describe, expect, it, vi } from 'vitest';
import { runAnalysisApi } from './runAnalysis';

afterEach(() => vi.unstubAllGlobals());

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

function sentRequest(fetch: ReturnType<typeof vi.fn>, index: number) {
  const [url, init] = fetch.mock.calls[index] as [string, RequestInit];
  return { url, method: init.method, body: init.body ? JSON.parse(init.body as string) : undefined };
}

describe('Run分析のAPI', () => {
  it('表はRun集合・param・metricをそのままbodyに入れてPOSTする', async () => {
    const fetch = vi.fn().mockResolvedValue(jsonResponse({ runs: [], params: [], metrics: [] }));
    vi.stubGlobal('fetch', fetch);
    await runAnalysisApi.table('p1', { runSet: { search: { experimentIds: ['e1'] } }, metrics: ['loss'], params: ['lr'] });
    expect(sentRequest(fetch, 0)).toEqual({
      url: '/api/projects/p1/runs/analysis/table',
      method: 'POST',
      body: { runSet: { search: { experimentIds: ['e1'] } }, metrics: ['loss'], params: ['lr'] },
    });
  });

  it('重要度はSweepのときtargetMetricを省いて送れる', async () => {
    const fetch = vi.fn().mockResolvedValue(jsonResponse({ entries: [], excluded: [] }));
    vi.stubGlobal('fetch', fetch);
    await runAnalysisApi.parameterImportance('p1', { runSet: { sweepId: 's1' } });
    expect(sentRequest(fetch, 0)).toEqual({
      url: '/api/projects/p1/runs/analysis/parameter-importance',
      method: 'POST',
      body: { runSet: { sweepId: 's1' } },
    });
  });

  it('APIのエラーコードをそのまま投げ、形の違う応答は不正な応答として扱う', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: 'x', code: 'too_many_runs' }, 422))
      .mockResolvedValueOnce(jsonResponse({ runs: null }));
    vi.stubGlobal('fetch', fetch);
    await expect(runAnalysisApi.table('p1', { runSet: { runIds: ['a'] }, metrics: ['m'] })).rejects.toMatchObject({
      status: 422,
      code: 'too_many_runs',
    });
    await expect(runAnalysisApi.table('p1', { runSet: { runIds: ['a'] }, metrics: ['m'] })).rejects.toMatchObject({
      code: 'invalid_response',
    });
  });

  it('検索のRun集合はmetric名を最初の検索ページから集め、名前順の重複なしで返す', async () => {
    const fetch = vi.fn().mockResolvedValue(
      jsonResponse({
        items: [{ latestMetrics: { loss: 1, acc: 0.5 } }, { latestMetrics: { loss: 2 } }],
        nextCursor: null,
      }),
    );
    vi.stubGlobal('fetch', fetch);
    const options = await runAnalysisApi.metricOptions('p1', { search: { filter: "params.lr = '0.1'" } });
    expect(options).toEqual({ metricKeys: ['acc', 'loss'], objectiveMetric: null });
    expect(sentRequest(fetch, 0).body).toEqual({ filter: "params.lr = '0.1'", limit: 500 });
  });

  it('Run IDの集合は先頭50件をcompareしてmetric名を集め、1件だけなら問い合わせない', async () => {
    const fetch = vi.fn().mockResolvedValue(
      jsonResponse({ runs: [], rows: [{ namespace: 'params', key: 'lr' }, { namespace: 'metrics', key: 'loss' }] }),
    );
    vi.stubGlobal('fetch', fetch);
    const runIds = Array.from({ length: 60 }, (_, index) => `r${index}`);
    await expect(runAnalysisApi.metricOptions('p1', { runIds })).resolves.toEqual({
      metricKeys: ['loss'],
      objectiveMetric: null,
    });
    expect(sentRequest(fetch, 0).body.runIds).toHaveLength(50);
    await expect(runAnalysisApi.metricOptions('p1', { runIds: ['only'] })).resolves.toEqual({
      metricKeys: [],
      objectiveMetric: null,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('SweepはobjectiveのmetricをmetricKeysに含めて返す', async () => {
    const fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith('/sweeps/s1')) return jsonResponse({ objective: { metric: 'val_loss', goal: 'minimize' } });
      if (url.includes('/trials')) return jsonResponse({ items: [{ runId: 'r1' }, { runId: 'r2' }], nextCursor: null });
      return jsonResponse({ runs: [], rows: [{ namespace: 'metrics', key: 'acc' }] });
    });
    vi.stubGlobal('fetch', fetch);
    await expect(runAnalysisApi.metricOptions('p1', { sweepId: 's1' })).resolves.toEqual({
      metricKeys: ['acc', 'val_loss'],
      objectiveMetric: 'val_loss',
    });
  });
});
