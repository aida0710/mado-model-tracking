import { afterEach, describe, expect, it, vi } from 'vitest';
import { accessApi } from './access';

afterEach(() => vi.unstubAllGlobals());

function stubFetch(body: unknown, status = 200) {
  const response =
    status === 204 ? new Response(null, { status }) : new Response(JSON.stringify(body), { status });
  const fetch = vi.fn().mockResolvedValue(response);
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

describe('メンバーのAPI', () => {
  it('メンバー一覧はProjectのmembersを読み、中断signalを渡す', async () => {
    const fetch = stubFetch({ items: [] });
    const controller = new AbortController();
    expect(await accessApi.members('project/1', controller.signal)).toEqual([]);
    expect(fetch).toHaveBeenCalledWith('/api/projects/project%2F1/members', {
      credentials: 'include',
      signal: controller.signal,
    });
  });

  it('直接付与の保存はユーザーIDをencodeしてPUTでroleを送る', async () => {
    const fetch = stubFetch({});
    await accessApi.saveMember('project', 'user/1', 'editor');
    expect(fetch).toHaveBeenCalledWith('/api/projects/project/members/user%2F1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'editor' }),
      credentials: 'include',
    });
  });

  it('直接付与の削除はユーザーIDをencodeしてDELETEを送る', async () => {
    const fetch = stubFetch(null, 204);
    await accessApi.removeMember('project', 'user 1');
    expect(fetch).toHaveBeenCalledWith('/api/projects/project/members/user%201', {
      method: 'DELETE',
      credentials: 'include',
    });
  });
});

describe('group bindingのAPI', () => {
  it('group名の/や空白をencodeしてPUTでroleを送る', async () => {
    const fetch = stubFetch({ group: 'ml/team a', role: 'admin' });
    await accessApi.saveGroupBinding('project', 'ml/team a', 'admin');
    expect(fetch).toHaveBeenCalledWith('/api/projects/project/group-bindings/ml%2Fteam%20a', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'admin' }),
      credentials: 'include',
    });
  });

  it('group bindingの削除はgroup名をencodeしてDELETEを送る', async () => {
    const fetch = stubFetch(null, 204);
    await accessApi.removeGroupBinding('project', 'ml#team');
    expect(fetch).toHaveBeenCalledWith('/api/projects/project/group-bindings/ml%23team', {
      method: 'DELETE',
      credentials: 'include',
    });
  });

  it('一覧のitemsが配列でなければ空一覧へ補完せずエラーにする', async () => {
    stubFetch({});
    await expect(accessApi.groupBindings('project')).rejects.toThrow();
  });

  it('group名の候補はauth/groupsから読む', async () => {
    const fetch = stubFetch({ items: ['ml-team'] });
    expect(await accessApi.groups()).toEqual(['ml-team']);
    expect(fetch.mock.calls[0]?.[0]).toBe('/api/auth/groups');
  });
});

describe('ユーザー検索のAPI', () => {
  it('検索語の記号や空白はqueryとしてencodeして送る', async () => {
    const fetch = stubFetch({ items: [] });
    await accessApi.searchUsers('a+b@example.com &x');
    const url = new URL(fetch.mock.calls[0]?.[0] as string, 'http://localhost');
    expect(url.pathname).toBe('/api/users');
    expect(url.searchParams.get('query')).toBe('a+b@example.com &x');
    expect([...url.searchParams.keys()]).toEqual(['query']);
  });
});
