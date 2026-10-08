// Stub for run-notes-comments-web: only the props this package's components implement.
// metrics-chart-core-web owns this file; its version replaces this one at integration.
import type { CommentTargetType, Run } from '@mmt/contracts';

export interface CommentThreadProps {
  projectId: string;
  targetType: CommentTargetType;
  targetId: string;
}

export interface RunDescriptionEditorProps {
  projectId: string;
  run: Run;
}
