import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReportBlock, ReportEmbedBlock } from '@mmt/contracts';
import { isReportRevisionConflict, reportsApi } from './reports';
import { loadLiveBlockData } from './reportLiveData';
import { RequestError } from './http';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const document = { report: { id: 'report' }, revision: { revision: 2, blocks: [] } };
const blocks: ReportBlock[] = [{ id: 'b1', type: 'markdown', text: '# 結果' }];

afterEach(() => vi.unstubAllGlobals());

const requests = (fetch: ReturnType<typeof vi.fn>) =>
  fetch.mock.calls.map(([path, options]) => [path, options?.method ?? 'GET', options?.body ? JSON.parse(options.body) : undefined]);

describe('レポートAPIのpathとbody', () => {
  it('一覧はアーカイブ済みを頼んだときだけincludeArchivedを付ける', async () => {
    const fetch = vi.fn().mockImplementation(() => Promise.resolve(json({ items: [], nextCursor: null })));
    vi.stubGlobal('fetch', fetch);
    await reportsApi.list('project', { includeArchived: false });
    await reportsApi.list('project', { includeArchived: true, cursor: 'next' });
    expect(fetch.mock.calls.map(([path]) => path)).toEqual([
      '/api/projects/project/reports',
      '/api/projects/project/reports?includeArchived=true&cursor=next',
    ]);
  });

  it('過去の版はrevisionをqueryで、固定データは版ごとに読む', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(json(document))
      .mockResolvedValueOnce(json(document))
      .mockResolvedValueOnce(json({ items: [] }))
      .mockResolvedValueOnce(json({ revision: 1, items: [] }));
    vi.stubGlobal('fetch', fetch);
    await reportsApi.get('project', 'report/1');
    await reportsApi.get('project', 'report/1', { revision: 1 });
    await reportsApi.revisions('project', 'report/1');
    await reportsApi.snapshots('project', 'report/1', 1);
    expect(fetch.mock.calls.map(([path]) => path)).toEqual([
      '/api/projects/project/reports/report%2F1',
      '/api/projects/project/reports/report%2F1?revision=1',
      '/api/projects/project/reports/report%2F1/revisions',
      '/api/projects/project/reports/report%2F1/snapshots?revision=1',
    ]);
  });

  it('保存は編集を始めた版と作り直す固定ブロックをPUTし、戻すとアーカイブはPOSTする', async () => {
    const fetch = vi.fn().mockImplementation(() => Promise.resolve(json(document)));
    vi.stubGlobal('fetch', fetch);
    await reportsApi.create('project', { title: '週報', blocks });
    await reportsApi.update('project', 'report', {
      baseRevision: 2,
      title: '週報',
      blocks,
      message: '図を追加',
      refreshSnapshotBlockIds: ['b2'],
    });
    await reportsApi.restore('project', 'report', { revision: 1, baseRevision: 3 });
    await reportsApi.archive('project', 'report');
    await reportsApi.unarchive('project', 'report');
    expect(requests(fetch)).toEqual([
      ['/api/projects/project/reports', 'POST', { title: '週報', blocks }],
      [
        '/api/projects/project/reports/report',
        'PUT',
        { baseRevision: 2, title: '週報', blocks, message: '図を追加', refreshSnapshotBlockIds: ['b2'] },
      ],
      ['/api/projects/project/reports/report/restore', 'POST', { revision: 1, baseRevision: 3 }],
      ['/api/projects/project/reports/report/archive', 'POST', undefined],
      ['/api/projects/project/reports/report/unarchive', 'POST', undefined],
    ]);
  });

  it('409 report_revision_conflictだけを版の衝突として見分ける', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(json({ error: '別の版が保存されています', code: 'report_revision_conflict' }, 409)),
    );
    const failure = await reportsApi.update('project', 'report', { baseRevision: 1, title: 't', blocks }).catch((error) => error);
    expect(isReportRevisionConflict(failure)).toBe(true);
    expect(isReportRevisionConflict(new RequestError({ status: 409, code: 'other_conflict' }))).toBe(false);
    expect(isReportRevisionConflict(new RequestError({ status: 422, code: 'report_revision_conflict' }))).toBe(false);
  });

  it('埋め込める保存ビューはプロジェクトに公開したものだけにする', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        json({ items: [{ id: 'mine', visibility: 'private' }, { id: 'shared', visibility: 'project' }] }),
      ),
    );
    expect((await reportsApi.shareableSavedViews('project')).map((view) => view.id)).toEqual(['shared']);
  });

  it('版や配列の欠けた応答は契約違反として扱う', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ report: { id: 'report' } })));
    await expect(reportsApi.get('project', 'report')).rejects.toMatchObject({ code: 'invalid_response' });
  });
});

describe('liveの埋め込みの取得', () => {
  const signal = new AbortController().signal;

  it('保存ビューのグループ図は、ビューを読んでその検索条件でグループを頼む', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(
        json({
          id: 'view',
          visibility: 'project',
          state: { version: 1, experimentIds: [], filter: "params.lr = '0.1'", orderBy: [], statuses: [], kinds: [], columns: [], chartPanels: { version: 1, columns: 12, panels: [] } },
        }),
      )
      .mockResolvedValueOnce(json({ groups: [] }));
    vi.stubGlobal('fetch', fetch);
    const block: ReportEmbedBlock = {
      id: 'chart',
      type: 'chart',
      runSet: { savedViewId: 'view' },
      mode: 'live',
      panel: {
        id: 'chart',
        metricKeys: ['loss'],
        xAxis: { kind: 'step' },
        yScale: 'linear',
        smoothing: { kind: 'none', weight: 0 },
        showRange: true,
        groupBy: { kind: 'param', key: 'lr' },
        layout: { x: 0, y: 0, w: 12, h: 2 },
      },
    };
    const data = await loadLiveBlockData('project', block, signal);
    expect(data).toEqual({ type: 'chart', plan: { kind: 'groups', groups: [] }, runLabels: {} });
    const [viewRequest, groupsRequest] = requests(fetch);
    expect(viewRequest![0]).toBe('/api/projects/project/saved-views/view');
    expect(groupsRequest![0]).toBe('/api/projects/project/metrics/groups');
    expect(groupsRequest![2]).toMatchObject({ search: { filter: "params.lr = '0.1'" }, groupBy: { kind: 'param', key: 'lr' }, keys: ['loss'] });
  });

  it('選んだRunの一覧は報告に並べた順で返し、見えないRunは抜ける', async () => {
    const fetch = vi.fn().mockResolvedValue(json({ items: [{ id: 'b', name: 'B' }, { id: 'a', name: 'A' }], nextCursor: null }));
    vi.stubGlobal('fetch', fetch);
    const data = await loadLiveBlockData(
      'project',
      { id: 't', type: 'run_table', runSet: { runIds: ['a', 'hidden', 'b'] }, columns: [], limit: 50, mode: 'live' },
      signal,
    );
    expect(data.type === 'run_table' && data.runs.map((run) => run.id)).toEqual(['a', 'b']);
    expect(requests(fetch)[0]![2]).toEqual({ filter: "attributes.run_id IN ('a', 'hidden', 'b')", limit: 500 });
  });
});
