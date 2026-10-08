import type { Comment, ProjectRole } from '@mmt/contracts';
import { canEditProject, canManageProject } from './permissions';

// Mirrors commentService on the API so the thread hides actions it would reject.

export interface CommentViewer {
  userId: string;
  role: ProjectRole;
}

/** Posting and replying need the editor role; a viewer only reads. */
export function canPostComment(viewer: CommentViewer): boolean {
  return canEditProject(viewer.role);
}

/** Only the author edits, and only while they can still post in the Project. */
export function canEditComment(comment: Comment, viewer: CommentViewer): boolean {
  return !comment.deleted && comment.author.id === viewer.userId && canEditProject(viewer.role);
}

/** The author (editor or above) or a Project admin may delete. */
export function canDeleteComment(comment: Comment, viewer: CommentViewer): boolean {
  if (comment.deleted) return false;
  if (canManageProject(viewer.role)) return true;
  return comment.author.id === viewer.userId && canEditProject(viewer.role);
}
