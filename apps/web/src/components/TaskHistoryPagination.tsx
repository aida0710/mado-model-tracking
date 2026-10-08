import { text } from '../i18n/catalog';

export function TaskHistoryPagination({ cursor, nextCursor, loading, onChange }: {
  cursor: string; nextCursor: string | null; loading: boolean;
  onChange: (cursor: string | null) => void;
}) {
  return <nav className="section-actions" aria-label={text.taskHistory}>
    <button className="button small" disabled={loading || !cursor} data-testid="task-history-latest"
      onClick={() => onChange(null)}>{text.latestTaskRuns}</button>
    <button className="button small" disabled={loading || !nextCursor} data-testid="task-history-older"
      onClick={() => onChange(nextCursor)}>{text.olderTaskRuns}</button>
  </nav>;
}
