// Stub for this worktree: run-notes-comments-web owns the real comment thread (same props as
// CommentThreadProps in components/charts/chartProps.ts). Integration keeps that implementation.
export interface CommentThreadProps {
  projectId: string;
  targetType: 'run' | 'model_version';
  targetId: string;
}

export function CommentThread(_props: CommentThreadProps) {
  return null;
}
