import { useSearchParams } from 'react-router-dom';
import { tasksApi } from '../api/tasks';
import { EXECUTION_POLL_MS, useQuery } from './useQuery';

export function useTaskRunHistory({ projectId, taskId }: { projectId: string; taskId?: string }) {
  const [params, setParams] = useSearchParams();
  const cursor = params.get('id') === taskId ? params.get('historyCursor') ?? '' : '';
  const history = useQuery(taskId ? `${projectId}:task-runs:${taskId}:${cursor}` : null,
    (signal) => tasksApi.runs(projectId, taskId!, { cursor: cursor || undefined, signal }), EXECUTION_POLL_MS);
  function changeCursor(nextCursor: string | null) {
    if (!taskId) return;
    setParams((previous) => {
      const next = new URLSearchParams(previous);
      next.set('id', taskId);
      if (nextCursor) next.set('historyCursor', nextCursor);
      else next.delete('historyCursor');
      return next;
    });
  }
  return { ...history, cursor, changeCursor };
}
