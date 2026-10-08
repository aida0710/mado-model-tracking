import { afterEach, describe, expect, it, vi } from 'vitest';
import { tasksApi } from './tasks';
import { executionApi } from './execution';
import { administrationApi } from './administration';

afterEach(() => vi.unstubAllGlobals());
describe('Taskと管理設定の変更', () => {
  it('Task更新は期待revisionを送り実験の変更をAPI入力に含めない', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    await tasksApi.update('project', 'task', { expectedRevision: 7, name: 'changed' });
    expect(fetch.mock.calls[0]?.[0]).toBe('/api/projects/project/tasks/task');
    expect(JSON.parse(fetch.mock.calls[0]?.[1].body)).toEqual({ expectedRevision: 7, name: 'changed' });
  });
  it('起動409を成功として扱わず再試行に返す', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'Task revision changed' }), { status: 409 })));
    await expect(tasksApi.launch('project', 'task', { expectedRevision: 7, executionMode: 'test' })).rejects.toThrow('Task revision changed');
  });
  it('Task履歴は50件とcursorを指定し次ページ情報を保持する', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ items: [], nextCursor: 'older' }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    const controller = new AbortController();
    const page = await tasksApi.runs('project', 'task', { cursor: 'last-run', signal: controller.signal });
    expect(fetch.mock.calls[0]?.[0]).toBe('/api/projects/project/tasks/task/runs?limit=50&cursor=last-run');
    expect(fetch.mock.calls[0]?.[1].signal).toBe(controller.signal);
    expect(page).toEqual({ items: [], nextCursor: 'older' });
  });
  it('Task履歴のnextCursorが欠けている応答はページ終了として扱わない', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ items: [] }), { status: 200 })));
    await expect(tasksApi.runs('project', 'task')).rejects.toThrow();
  });
  it('有効無効の変更はenabledだけをPATCHし接続設定を書き戻さない', async () => {
    const fetch = vi.fn().mockImplementation(() => Promise.resolve(new Response('{}', { status: 200 })));
    vi.stubGlobal('fetch', fetch);
    await executionApi.updateTarget('target', { enabled: false });
    await administrationApi.updatePlugin('project', 'plugin', { enabled: true });
    expect(fetch.mock.calls.map(([path, options]) => [path, options.method, JSON.parse(options.body)])).toEqual([
      ['/api/targets/target', 'PATCH', { enabled: false }],
      ['/api/projects/project/plugins/plugin', 'PATCH', { enabled: true }],
    ]);
  });
});
