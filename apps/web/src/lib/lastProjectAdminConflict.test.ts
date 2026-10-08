import { describe, expect, it } from 'vitest';
import { RequestError } from '../api/http';
import { text } from '../i18n/catalog';
import { explainLastProjectAdminConflict } from './lastProjectAdminConflict';

describe('最後のProject adminを外す変更', () => {
  it('409は管理者がいなくなる理由の文言に置き換える', async () => {
    const conflict = new RequestError({ status: 409, code: 'conflict', serverMessage: 'raw' });
    await expect(explainLastProjectAdminConflict(Promise.reject(conflict))).rejects.toThrow(
      text.lastProjectAdminConflict,
    );
  });

  it('409以外の失敗はそのまま返す', async () => {
    const forbidden = new RequestError({ status: 403, code: 'forbidden' });
    await expect(explainLastProjectAdminConflict(Promise.reject(forbidden))).rejects.toBe(
      forbidden,
    );
  });

  it('成功した変更の結果はそのまま返す', async () => {
    expect(await explainLastProjectAdminConflict(Promise.resolve('saved'))).toBe('saved');
  });
});
