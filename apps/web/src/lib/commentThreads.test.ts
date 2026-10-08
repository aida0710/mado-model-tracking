import { describe, expect, it } from 'vitest';
import type { Comment } from '@mmt/contracts';
import { groupCommentThreads, mergeComments } from './commentThreads';

function comment(id: string, minute: number, parentCommentId: string | null = null): Comment {
  return {
    id,
    projectId: 'p',
    targetType: 'run',
    targetId: 'r',
    parentCommentId,
    body: id,
    author: { id: 'u1', displayName: '相田' },
    createdAt: new Date(Date.UTC(2026, 9, 8, 10, minute)).toISOString(),
    editedAt: null,
    deleted: false,
  };
}
const ids = (threads: ReturnType<typeof groupCommentThreads>) =>
  threads.map((thread) => [thread.root.id, ...thread.replies.map((reply) => reply.id)]);

describe('コメントのスレッド', () => {
  it('先頭を作成順に並べ、返信を各スレッドの下に作成順で置く', () => {
    const threads = groupCommentThreads([
      comment('b', 2),
      comment('b-reply2', 6, 'b'),
      comment('a', 1),
      comment('a-reply', 3, 'a'),
      comment('b-reply1', 4, 'b'),
    ]);
    expect(ids(threads)).toEqual([['a', 'a-reply'], ['b', 'b-reply1', 'b-reply2']]);
  });

  it('同じ時刻はidの順に並べる', () => {
    expect(ids(groupCommentThreads([comment('y', 1), comment('x', 1)]))).toEqual([['x'], ['y']]);
  });

  it('先頭が読み込まれていない返信も隠さずに単独で表示する', () => {
    expect(ids(groupCommentThreads([comment('a', 1), comment('lost', 2, 'missing')]))).toEqual([
      ['a'],
      ['lost'],
    ]);
  });

  it('この画面で投稿・編集したコメントを読み込み済みのページへ重複なく反映する', () => {
    const edited = { ...comment('a', 1), body: '編集後', editedAt: '2026-10-08T11:00:00.000Z' };
    const merged = mergeComments([comment('a', 1), comment('b', 2)], [edited, comment('c', 3)]);
    expect(merged.map((item) => [item.id, item.body])).toEqual([
      ['a', '編集後'],
      ['b', 'b'],
      ['c', 'c'],
    ]);
  });
});
