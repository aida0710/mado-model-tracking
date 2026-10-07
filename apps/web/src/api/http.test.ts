import { afterEach, describe, expect, it, vi } from 'vitest';
import { request, requestItems } from './http';

afterEach(() => vi.unstubAllGlobals());
describe('API応答の扱い', () => {
  it('保存失敗の理由とステータスを呼び出し元へ返す', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ error: '保存できません', code: 'storage_failed' }), {
            status: 503,
          }),
        ),
    );
    await expect(request('/test')).rejects.toMatchObject({
      message: '保存できません',
      status: 503,
      code: 'storage_failed',
    });
  });
  it('一覧の応答形式が壊れていると成功した空配列として扱わない', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ values: [] }), { status: 200 })),
    );
    await expect(requestItems('/test')).rejects.toThrow();
  });
  it('ブラウザの中断を接続障害に置き換えない', async () => {
    const abort = new DOMException('Aborted', 'AbortError');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(abort));
    await expect(request('/test')).rejects.toBe(abort);
  });
});
