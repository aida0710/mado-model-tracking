import { useMemo, useState } from 'react';
import type { Comment } from '@mmt/contracts';
import { commentsApi, type CommentTarget } from '../api/comments';
import { groupCommentThreads, mergeComments, type CommentThreadGroup } from '../lib/commentThreads';
import { useCursorPages } from './useCursorPages';

export interface CommentsState {
  threads: CommentThreadGroup[];
  hasMore: boolean;
  loading: boolean;
  error: string | null;
  loadMore: () => void;
  reload: () => void;
  /** parentCommentId null starts a new thread. Rejects with the API error. */
  post: (input: { body: string; parentCommentId: string | null }) => Promise<Comment>;
  edit: (commentId: string, body: string) => Promise<Comment>;
  remove: (comment: Comment) => Promise<void>;
}

/**
 * Reads one target's comment threads page by page and keeps comments posted, edited or deleted
 * here visible without reading every loaded page again.
 */
export function useComments(projectId: string, target: CommentTarget): CommentsState {
  const key = `${projectId}:${target.targetType}:${target.targetId}`;
  const pages = useCursorPages(key, (cursor, signal) =>
    commentsApi.list(projectId, target, { cursor, signal }),
  );
  // Tied to the key so another target, or a reload, starts again from the API's answer.
  const [localChanges, setLocalChanges] = useState<{ key: string; comments: Comment[] }>({
    key,
    comments: [],
  });
  const localComments = localChanges.key === key ? localChanges.comments : [];
  const threads = useMemo(
    () => groupCommentThreads(mergeComments(pages.items, localComments)),
    [pages.items, localComments],
  );

  function keepLocally(comment: Comment) {
    setLocalChanges((previous) => ({
      key,
      comments: [
        ...(previous.key === key ? previous.comments : []).filter((item) => item.id !== comment.id),
        comment,
      ],
    }));
  }

  return {
    threads,
    hasMore: pages.hasMore,
    loading: pages.loading,
    error: pages.error,
    loadMore: pages.loadMore,
    reload: () => {
      setLocalChanges({ key, comments: [] });
      pages.reload();
    },
    post: async ({ body, parentCommentId }) => {
      const created = await commentsApi.create(projectId, { ...target, parentCommentId, body });
      keepLocally(created);
      return created;
    },
    edit: async (commentId, body) => {
      const updated = await commentsApi.update(projectId, commentId, { body });
      keepLocally(updated);
      return updated;
    },
    remove: async (comment) => {
      await commentsApi.remove(projectId, comment.id);
      // DELETE answers 204, so the deleted state is written the way the API would return it.
      keepLocally({ ...comment, body: null, deleted: true });
    },
  };
}
