import { describe, expect, it } from 'vitest';
import type { Comment } from '@mmt/contracts';
import { canDeleteComment, canEditComment, canPostComment } from './commentPermissions';

const own: Comment = {
  id: 'c1',
  projectId: 'p',
  targetType: 'run',
  targetId: 'r',
  parentCommentId: null,
  body: '本文',
  author: { id: 'me', displayName: '自分' },
  createdAt: '2026-10-08T10:00:00.000Z',
  editedAt: null,
  deleted: false,
};
const others: Comment = { ...own, id: 'c2', author: { id: 'other', displayName: '他人' } };

describe('コメントの操作権限', () => {
  it('viewerは投稿・編集・削除のどれもできない', () => {
    const viewer = { userId: 'me', role: 'viewer' as const };
    expect(canPostComment(viewer)).toBe(false);
    expect(canEditComment(own, viewer)).toBe(false);
    expect(canDeleteComment(own, viewer)).toBe(false);
  });

  it('editorは自分のコメントだけを編集・削除できる', () => {
    const editor = { userId: 'me', role: 'editor' as const };
    expect(canPostComment(editor)).toBe(true);
    expect(canEditComment(own, editor)).toBe(true);
    expect(canDeleteComment(own, editor)).toBe(true);
    expect(canEditComment(others, editor)).toBe(false);
    expect(canDeleteComment(others, editor)).toBe(false);
  });

  it('Project adminは他人のコメントを削除できるが編集はできない', () => {
    const admin = { userId: 'me', role: 'admin' as const };
    expect(canDeleteComment(others, admin)).toBe(true);
    expect(canEditComment(others, admin)).toBe(false);
  });

  it('削除済みのコメントは誰も編集・削除できない', () => {
    const deleted = { ...own, body: null, deleted: true };
    expect(canEditComment(deleted, { userId: 'me', role: 'admin' })).toBe(false);
    expect(canDeleteComment(deleted, { userId: 'me', role: 'admin' })).toBe(false);
  });
});
