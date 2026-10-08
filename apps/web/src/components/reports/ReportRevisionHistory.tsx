import type { ReportRevisionSummary } from '@mmt/contracts';
import { Resource } from '../Feedback';
import { useReportRevisions } from '../../hooks/useReport';
import { formatDate } from '../../lib/format';
import { text, textTemplates } from '../../i18n/catalog';

/**
 * Revisions of a report, newest first. A past revision opens read-only; restoring copies it into a
 * new revision, so the history is never rewritten.
 */
export function ReportRevisionHistory({
  projectId,
  reportId,
  currentRevision,
  shownRevision,
  onShow,
  onRestore,
}: {
  projectId: string;
  reportId: string;
  currentRevision: number;
  shownRevision: number;
  onShow: (revision: number) => void;
  /** Absent when the reader may not edit. */
  onRestore?: (revision: ReportRevisionSummary) => void;
}) {
  const revisions = useReportRevisions(projectId, reportId, currentRevision);
  return (
    <section className="report-history" aria-label={text.reportHistory}>
      <h2>{text.reportHistory}</h2>
      <Resource query={revisions}>
        {(items) =>
          items.length === 0 ? (
            <p className="muted">{text.reportHistoryEmpty}</p>
          ) : (
            <ol className="report-history-list">
              {items.map((item) => (
                <li key={item.revision} className={item.revision === shownRevision ? 'active' : ''}>
                  <div className="report-history-heading">
                    <strong>{textTemplates.reportRevisionLabel(item.revision)}</strong>
                    {item.revision === currentRevision && <span className="report-badge">{text.reportHistoryCurrent}</span>}
                  </div>
                  <div className="muted">
                    {item.createdBy.displayName}・{formatDate(item.createdAt)}
                  </div>
                  {item.message && <p className="report-history-message">{item.message}</p>}
                  {item.restoredFrom !== null && (
                    <p className="muted">{textTemplates.reportRestoredFrom(item.restoredFrom)}</p>
                  )}
                  <div className="report-history-actions">
                    {item.revision === shownRevision ? (
                      <span className="muted">{text.reportHistoryShowing}</span>
                    ) : (
                      <button type="button" className="button small" onClick={() => onShow(item.revision)}>
                        {text.reportHistoryShow}
                      </button>
                    )}
                    {onRestore && item.revision !== currentRevision && (
                      <button type="button" className="button small" onClick={() => onRestore(item)}>
                        {text.reportRestore}
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ol>
          )
        }
      </Resource>
    </section>
  );
}
