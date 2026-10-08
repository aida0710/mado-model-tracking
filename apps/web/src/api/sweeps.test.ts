import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SweepCreate } from '@mmt/contracts';
import { sweepsApi } from './sweeps';
import { RequestError } from './http';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const sweep = { id: 'sweep', trialCounts: { total: 0 } };

afterEach(() => vi.unstubAllGlobals());

describe('Sweep APIのpathとbody', () => {
  it('一覧は状態とcursorをqueryに付け、未指定なら付けない', async () => {
    const fetch = vi.fn().mockImplementation(() => Promise.resolve(json({ items: [], nextCursor: null })));
    vi.stubGlobal('fetch', fetch);
    await sweepsApi.list('project', { status: 'paused', cursor: 'next' });
    await sweepsApi.list('project');
    expect(fetch.mock.calls.map(([path]) => path)).toEqual([
      '/api/projects/project/sweeps?status=paused&cursor=next',
      '/api/projects/project/sweeps',
    ]);
  });

  it('作成は入力をそのままPOSTする', async () => {
    const fetch = vi.fn().mockResolvedValue(json(sweep, 201));
    vi.stubGlobal('fetch', fetch);
    const input: SweepCreate = {
      name: 'lr-search',
      taskId: 'task',
      method: 'grid',
      searchSpace: { lr: { values: [0.1, 0.01] } },
      objective: { metric: 'val_loss', goal: 'minimize', aggregation: 'last' },
      maxTrials: 4,
      parallelism: 2,
      earlyStopping: null,
      targetId: null,
      gpuIds: null,
    };
    await sweepsApi.create('project', input);
    const [path, options] = fetch.mock.calls[0]!;
    expect([path, options.method, JSON.parse(options.body)]).toEqual(['/api/projects/project/sweeps', 'POST', input]);
  });

  it('pause・resume・cancel・PATCHはSweepごとのpathへ送り、cancelは実行中の扱いをbodyに入れる', async () => {
    const fetch = vi.fn().mockImplementation(() => Promise.resolve(json(sweep)));
    vi.stubGlobal('fetch', fetch);
    await sweepsApi.pause('project', 'sweep/1');
    await sweepsApi.resume('project', 'sweep/1');
    await sweepsApi.cancel('project', 'sweep/1', { cancelRunningTrials: true });
    await sweepsApi.update('project', 'sweep/1', { parallelism: 3 });
    expect(fetch.mock.calls.map(([path, options]) => [path, options.method, options.body && JSON.parse(options.body)])).toEqual([
      ['/api/projects/project/sweeps/sweep%2F1/pause', 'POST', undefined],
      ['/api/projects/project/sweeps/sweep%2F1/resume', 'POST', undefined],
      ['/api/projects/project/sweeps/sweep%2F1/cancel', 'POST', { cancelRunningTrials: true }],
      ['/api/projects/project/sweeps/sweep%2F1', 'PATCH', { parallelism: 3 }],
    ]);
  });

  it('全試行の取得はnextCursorを辿って試行番号順の全ページをつなぐ', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(json({ items: [{ trialIndex: 0 }], nextCursor: 'page-2' }))
      .mockResolvedValueOnce(json({ items: [{ trialIndex: 1 }], nextCursor: null }));
    vi.stubGlobal('fetch', fetch);
    const trials = await sweepsApi.allTrials('project', 'sweep');
    expect(trials.map((trial) => trial.trialIndex)).toEqual([0, 1]);
    expect(fetch.mock.calls.map(([path]) => path)).toEqual([
      '/api/projects/project/sweeps/sweep/trials?orderBy=trial_index&limit=500',
      '/api/projects/project/sweeps/sweep/trials?orderBy=trial_index&limit=500&cursor=page-2',
    ]);
  });

  it('同じcursorを返し続ける応答では無限に読まずに止まる', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => Promise.resolve(json({ items: [], nextCursor: 'same' }))));
    await expect(sweepsApi.allTrials('project', 'sweep')).resolves.toEqual([]);
  });

  it('nextCursorの欠けたページは契約違反として扱う', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ items: [] })));
    await expect(sweepsApi.list('project')).rejects.toBeInstanceOf(RequestError);
  });

  it('探索空間の422はcodeとサーバーのmessageを保って返す', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(
      { error: 'parameter「lr」は min < max である必要があります（min=1, max=0）', code: 'sweep_space_invalid' }, 422)));
    const failure = await sweepsApi.create('project', {} as SweepCreate).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RequestError);
    expect((failure as RequestError).code).toBe('sweep_space_invalid');
    expect((failure as RequestError).serverMessage).toContain('「lr」');
  });

  it('目的メトリクスの重ね描きは試行RunのstepをPOST /metrics/seriesで読む', async () => {
    const fetch = vi.fn().mockResolvedValue(json({ series: [] }));
    vi.stubGlobal('fetch', fetch);
    await sweepsApi.objectiveSeries('project', { runIds: ['run-1', 'run-2'], metric: 'val_loss' });
    const [path, options] = fetch.mock.calls[0]!;
    expect([path, options.method, JSON.parse(options.body)]).toEqual([
      '/api/projects/project/metrics/series',
      'POST',
      { runIds: ['run-1', 'run-2'], keys: ['val_loss'], xAxis: { kind: 'step' } },
    ]);
  });
});
