import type { Comment, CommentTargetType } from '@mmt/contracts';
import { first, rows, type Connection } from '../db/database.js';

export interface CommentTarget {
  projectId: string;
  targetType: CommentTargetType;
  targetId: string;
}

/** A stored comment including fields the API does not expose. */
export interface StoredComment {
  id: string;
  projectId: string;
  targetType: CommentTargetType;
  targetId: string;
  parentCommentId: string | null;
  body: string;
  authorUserId: string;
  authorDisplayName: string;
  createdAt: string;
  editedAt: string | null;
  deletedAt: string | null;
}

const storedCommentSelect = `SELECT c.id,c.project_id,c.target_type,c.target_id,c.parent_comment_id,
  c.body,c.author_user_id,u.display_name AS author_display_name,c.created_at,c.edited_at,c.deleted_at
  FROM comments c JOIN users u ON u.id=c.author_user_id`;

// A deleted comment keeps its place in the thread but never exposes its body.
export function toComment(stored: StoredComment): Comment {
  const deleted = stored.deletedAt !== null;
  return {
    id: stored.id,
    projectId: stored.projectId,
    targetType: stored.targetType,
    targetId: stored.targetId,
    parentCommentId: stored.parentCommentId,
    body: deleted ? null : stored.body,
    author: { id: stored.authorUserId, displayName: stored.authorDisplayName },
    createdAt: stored.createdAt,
    editedAt: stored.editedAt,
    deleted,
  };
}

export async function findComment(
  connection: Connection,
  comment: { projectId: string; commentId: string; lock?: boolean },
): Promise<StoredComment | undefined> {
  return first<StoredComment>(
    connection,
    `${storedCommentSelect} WHERE c.id=$1 AND c.project_id=$2 ${comment.lock ? 'FOR UPDATE OF c' : ''}`,
    [comment.commentId, comment.projectId],
  );
}

export async function insertComment(
  connection: Connection,
  comment: CommentTarget & { parentCommentId: string | null; body: string; authorUserId: string },
): Promise<StoredComment> {
  const inserted = await first<{ id: string }>(
    connection,
    `INSERT INTO comments(project_id,target_type,target_id,parent_comment_id,body,author_user_id)
    VALUES($1,$2,$3,$4,$5,$6) RETURNING id`,
    [
      comment.projectId,
      comment.targetType,
      comment.targetId,
      comment.parentCommentId,
      comment.body,
      comment.authorUserId,
    ],
  );
  return (await findComment(connection, {
    projectId: comment.projectId,
    commentId: inserted!.id,
  }))!;
}

export async function updateCommentBody(
  connection: Connection,
  comment: { commentId: string; body: string },
): Promise<void> {
  await connection.query('UPDATE comments SET body=$2,edited_at=now() WHERE id=$1', [
    comment.commentId,
    comment.body,
  ]);
}

export async function markCommentDeleted(
  connection: Connection,
  comment: { commentId: string; deletedByUserId: string },
): Promise<void> {
  await connection.query(
    'UPDATE comments SET deleted_at=now(),deleted_by_user_id=$2 WHERE id=$1 AND deleted_at IS NULL',
    [comment.commentId, comment.deletedByUserId],
  );
}

// Thread order: roots by (created_at,id), each followed by its replies by (created_at,id).
// thread_depth keeps a root ahead of a reply that has the same created_at.
const threadOrderedComments = `WITH ordered AS (
  SELECT c.id,COALESCE(root.created_at,c.created_at) AS thread_created_at,
    COALESCE(root.id,c.id) AS thread_id,(c.parent_comment_id IS NOT NULL)::int AS thread_depth,
    c.created_at
  FROM comments c LEFT JOIN comments root ON root.id=c.parent_comment_id
  WHERE c.project_id=$1 AND c.target_type=$2 AND c.target_id=$3
)`;

export async function commentCursorExists(
  connection: Connection,
  cursor: CommentTarget & { commentId: string },
): Promise<boolean> {
  return Boolean(
    await first(
      connection,
      'SELECT id FROM comments WHERE id=$1 AND project_id=$2 AND target_type=$3 AND target_id=$4',
      [cursor.commentId, cursor.projectId, cursor.targetType, cursor.targetId],
    ),
  );
}

// Keyset pagination stays stable when comments are added to earlier threads between pages.
export async function listThreadComments(
  connection: Connection,
  page: CommentTarget & { cursor: string | null; limit: number },
): Promise<StoredComment[]> {
  return rows<StoredComment>(
    connection,
    `${threadOrderedComments}
    ${storedCommentSelect} JOIN ordered o ON o.id=c.id
    WHERE $4::uuid IS NULL OR (o.thread_created_at,o.thread_id,o.thread_depth,o.created_at,o.id) >
      (SELECT thread_created_at,thread_id,thread_depth,created_at,id FROM ordered WHERE id=$4)
    ORDER BY o.thread_created_at,o.thread_id,o.thread_depth,o.created_at,o.id LIMIT $5`,
    [page.projectId, page.targetType, page.targetId, page.cursor, page.limit],
  );
}
