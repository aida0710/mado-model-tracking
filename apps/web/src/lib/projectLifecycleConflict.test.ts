import { describe, expect, it } from 'vitest';
import { RequestError } from '../api/http';
import { text } from '../i18n/catalog';
import { explainProjectLifecycleConflict } from './projectLifecycleConflict';

const conflict = (code: string) => new RequestError({ status: 409, code, serverMessage: 'raw' });

describe('プロジェクトのアーカイブと完全な削除の409', () => {
  it('待機中・実行中のJobがあるアーカイブは、Jobを終えるよう案内する', async () => {
    await expect(
      explainProjectLifecycleConflict(Promise.reject(conflict('project_has_active_jobs'))),
    ).rejects.toThrow(text.projectHasActiveJobs);
  });

  it('アーカイブしていないプロジェクトの完全な削除は、先にアーカイブするよう案内する', async () => {
    await expect(
      explainProjectLifecycleConflict(Promise.reject(conflict('project_not_archived'))),
    ).rejects.toThrow(text.projectNotArchived);
  });

  it('知らない409とほかの失敗はそのまま返す', async () => {
    const other = conflict('something_else');
    await expect(explainProjectLifecycleConflict(Promise.reject(other))).rejects.toBe(other);
    const forbidden = new RequestError({ status: 403, code: 'forbidden' });
    await expect(explainProjectLifecycleConflict(Promise.reject(forbidden))).rejects.toBe(forbidden);
  });

  it('成功した結果はそのまま返す', async () => {
    expect(await explainProjectLifecycleConflict(Promise.resolve('done'))).toBe('done');
  });
});
