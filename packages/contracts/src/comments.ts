export type CommentTargetType = 'run' | 'model_version' | 'report';

export interface CommentAuthor {
  id: string;
  displayName: string;
}

/**
 * One comment in a thread. Replies are one level deep: parentCommentId is null for a thread root
 * and always points at a root for a reply. A deleted comment keeps its place with body=null.
 */
export interface Comment {
  id: string;
  projectId: string;
  targetType: CommentTargetType;
  targetId: string;
  parentCommentId: string | null;
  body: string | null;
  author: CommentAuthor;
  createdAt: string;
  editedAt: string | null;
  deleted: boolean;
}

export interface CommentCreate {
  targetType: CommentTargetType;
  targetId: string;
  parentCommentId?: string | null;
  body: string;
}

export interface CommentUpdate {
  body: string;
}

/** One page in thread order. nextCursor is the id to pass as `cursor` next. */
export interface CommentPage {
  items: Comment[];
  nextCursor: string | null;
}

/** The Run description is stored in this tag so MLflow clients read and write the same value. */
export const RUN_NOTE_TAG = 'mlflow.note.content';
/** Same as MLflow's tag value limit, so a note written through MLflow is always editable natively. */
export const RUN_NOTE_MAX_LENGTH = 8000;
export const COMMENT_MAX_LENGTH = 20000;

export interface RunNoteUpdate {
  content: string;
}

/** content is '' when the Run has no description. */
export interface RunNote {
  runId: string;
  content: string;
}
