import { afterEach, describe, expect, it, vi } from 'vitest';
import { automationApi } from './automation';

afterEach(() => vi.unstubAllGlobals());
describe('自動実行API', () => {
  it('有効無効のPATCHにはenabledだけを送り不変の設定を変更しない', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ id: 'rule', enabled: false })));
    vi.stubGlobal('fetch', fetch);
    await automationApi.setRuleEnabled('project', 'rule', false);
    expect(fetch).toHaveBeenCalledWith(
      '/api/projects/project/automation-rules/rule',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ enabled: false }),
      }),
    );
  });
  it('失敗した切替を成功扱いにせずエラーを返す', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ error: 'Admin required' }), { status: 403 }),
        ),
    );
    await expect(automationApi.setRuleEnabled('project', 'rule', true)).rejects.toMatchObject({
      status: 403,
    });
  });
});
