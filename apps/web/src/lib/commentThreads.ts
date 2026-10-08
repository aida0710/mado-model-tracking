import type { Comment } from '@mmt/contracts';

/** A thread root and its replies; replies are one level deep (docs/api-contract.md). */
export interface CommentThreadGroup {
  root: Comment;
  replies: Comment[];
}

/**
 * Combines the pages read from the API with comments posted, edited or deleted on this screen
 * since. The local copy wins because it is the API's answer to the later request.
 */
export function mergeComments(loaded: readonly Comment[], local: readonly Comment[]): Comment[] {
  const byId = new Map(loaded.map((comment) => [comment.id, comment]));
  for (const comment of local) byId.set(comment.id, comment);
  return [...byId.values()];
}

// The API's thread order: by createdAt, then id to break ties.
function compareByCreation(left: Comment, right: Comment): number {
  const byTime = Date.parse(left.createdAt) - Date.parse(right.createdAt);
  if (byTime !== 0) return byTime;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

/**
 * Groups comments into threads in the API's order. A reply whose root is not loaded is shown as
 * its own thread so it is never hidden.
 */
export function groupCommentThreads(comments: readonly Comment[]): CommentThreadGroup[] {
  const roots = comments.filter((comment) => comment.parentCommentId === null);
  const rootIds = new Set(roots.map((root) => root.id));
  const repliesByRoot = new Map<string, Comment[]>();
  const orphans: Comment[] = [];
  for (const comment of comments) {
    if (comment.parentCommentId === null) continue;
    if (!rootIds.has(comment.parentCommentId)) {
      orphans.push(comment);
      continue;
    }
    const replies = repliesByRoot.get(comment.parentCommentId) ?? [];
    replies.push(comment);
    repliesByRoot.set(comment.parentCommentId, replies);
  }
  return [...roots, ...orphans].sort(compareByCreation).map((root) => ({
    root,
    replies: (repliesByRoot.get(root.id) ?? []).sort(compareByCreation),
  }));
}
