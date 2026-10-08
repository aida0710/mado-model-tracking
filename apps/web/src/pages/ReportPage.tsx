import { useState } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Archive, ArchiveRestore, History, Pencil, RefreshCw } from 'lucide-react';
import type { ReportRevisionSummary } from '@mmt/contracts';
import { reportsApi } from '../api/reports';
import { useAuth } from '../hooks/useAuth';
import { useMutation } from '../hooks/useMutation';
import { useProject } from '../hooks/useProject';
import { useReportDocument } from '../hooks/useReport';
import { PageHeader } from '../components/PageHeader';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { Empty, ErrorNotice, Resource } from '../components/Feedback';
import { CommentThread } from '../components/comments/CommentThread';
import { ReportBlockView } from '../components/reports/ReportBlockView';
import { ReportEditor } from '../components/reports/ReportEditor';
import { ReportRevisionHistory } from '../components/reports/ReportRevisionHistory';
import { formatDate } from '../lib/format';
import { snapshotsByBlockId } from '../lib/reportBlocks';
import { text, textTemplates } from '../i18n/catalog';

/** Navigation state that opens the editor right away, set when a report is created. */
export interface ReportPageLocationState {
  edit?: boolean;
}

function parseRevision(value: string | null): number | undefined {
  const revision = Number(value);
  return value && Number.isInteger(revision) && revision > 0 ? revision : undefined;
}

/**
 * A report: its blocks, the revision history and the comment thread. `?revision=` shows a past
 * revision read-only. Editors edit the current revision in place.
 */
export function ReportPage() {
  const { reportId = '' } = useParams();
  const { project, canEdit, isProjectAdmin } = useProject();
  const { user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  const requestedRevision = parseRevision(params.get('revision'));
  const [isEditing, setEditing] = useState(() => (location.state as ReportPageLocationState | null)?.edit === true);
  const [isHistoryOpen, setHistoryOpen] = useState(requestedRevision !== undefined);
  const [restoring, setRestoring] = useState<ReportRevisionSummary | null>(null);
  const [isArchiving, setArchiving] = useState(false);
  const unarchiving = useMutation();
  const { document, snapshots } = useReportDocument(project.id, reportId, requestedRevision);

  function showRevision(revision: number | undefined) {
    setParams(revision === undefined ? {} : { revision: String(revision) });
  }
  function afterSave() {
    setEditing(false);
    showRevision(undefined);
    // Read the saved revision with its snapshots, which the save response does not carry.
    document.reload();
  }

  return (
    <section className="page report-page" data-testid="report-page">
      <Resource query={document}>
        {({ report, revision }) => {
          const isCurrent = revision.revision === report.currentRevision;
          const isArchived = report.archivedAt !== null;
          const canEditReport = canEdit && !isArchived;
          const canArchive = isProjectAdmin || (canEdit && report.createdBy.id === user.id);
          const snapshotMap = snapshotsByBlockId(snapshots.value ?? []);
          return (
            <>
              <PageHeader
                eyebrow={<Link to={`/projects/${project.id}/reports`}>{text.reports}</Link>}
                title={revision.title}
                description={textTemplates.reportUpdatedSummary(
                  revision.revision,
                  revision.createdBy.displayName,
                  formatDate(revision.createdAt),
                )}
                actions={
                  <>
                    {canEditReport && isCurrent && !isEditing && (
                      <button className="button primary" onClick={() => setEditing(true)}>
                        <Pencil size={15} />
                        {text.reportEdit}
                      </button>
                    )}
                    <button
                      className={`button ${isHistoryOpen ? 'active' : ''}`}
                      aria-pressed={isHistoryOpen}
                      onClick={() => setHistoryOpen(!isHistoryOpen)}
                    >
                      <History size={15} />
                      {text.reportHistory}
                    </button>
                    {canArchive && !isEditing && !isArchived && (
                      <button className="button" onClick={() => setArchiving(true)}>
                        <Archive size={15} />
                        {text.reportArchive}
                      </button>
                    )}
                    {canArchive && isArchived && (
                      <button
                        className="button"
                        disabled={unarchiving.pending}
                        onClick={() =>
                          void unarchiving.run(() => reportsApi.unarchive(project.id, report.id)).then(document.reload)
                        }
                      >
                        <ArchiveRestore size={15} />
                        {text.reportUnarchive}
                      </button>
                    )}
                    <button className="icon-button" aria-label={text.refresh} onClick={document.reload}>
                      <RefreshCw size={17} />
                    </button>
                  </>
                }
              />
              <ErrorNotice message={unarchiving.error} />
              {isArchived && <div className="notice report-archived-notice">{text.reportArchivedNotice}</div>}
              {!isCurrent && (
                <div className="notice report-past-notice" data-testid="report-past-notice">
                  <span>{textTemplates.reportShowingRevision(revision.revision, report.currentRevision)}</span>
                  <button className="button small" onClick={() => showRevision(undefined)}>
                    {text.reportLatest}
                  </button>
                </div>
              )}
              <div className={`report-layout ${isHistoryOpen ? 'with-history' : ''}`}>
                <div className="report-body">
                  {isEditing && isCurrent ? (
                    <ReportEditor
                      // A reloaded revision starts a fresh edit.
                      key={revision.revision}
                      projectId={project.id}
                      document={{ report, revision }}
                      snapshots={snapshots.value ?? []}
                      onSaved={afterSave}
                      onCancel={() => setEditing(false)}
                      onReloadLatest={document.reload}
                    />
                  ) : revision.blocks.length === 0 ? (
                    <Empty>{text.reportEmpty}</Empty>
                  ) : (
                    revision.blocks.map((block) => (
                      <ReportBlockView
                        key={block.id}
                        projectId={project.id}
                        block={block}
                        snapshot={snapshotMap.get(block.id)}
                        snapshotState={snapshots}
                      />
                    ))
                  )}
                </div>
                {isHistoryOpen && (
                  <aside className="report-history-aside">
                    <ReportRevisionHistory
                      projectId={project.id}
                      reportId={report.id}
                      currentRevision={report.currentRevision}
                      shownRevision={revision.revision}
                      onShow={(shown) => showRevision(shown === report.currentRevision ? undefined : shown)}
                      onRestore={canEditReport && !isEditing ? setRestoring : undefined}
                    />
                  </aside>
                )}
              </div>
              <CommentThread projectId={project.id} targetType="report" targetId={report.id} />
              {restoring && (
                <ConfirmDialog
                  title={text.reportRestoreTitle}
                  message={textTemplates.reportRestoreMessage(restoring.revision)}
                  confirmLabel={text.reportRestore}
                  onConfirm={() =>
                    reportsApi.restore(project.id, report.id, {
                      revision: restoring.revision,
                      baseRevision: report.currentRevision,
                    })
                  }
                  onConfirmed={() => {
                    setRestoring(null);
                    showRevision(undefined);
                    document.reload();
                  }}
                  onClose={() => setRestoring(null)}
                />
              )}
              {isArchiving && (
                <ConfirmDialog
                  title={text.reportArchiveTitle}
                  message={text.reportArchiveMessage}
                  confirmLabel={text.reportArchive}
                  onConfirm={() => reportsApi.archive(project.id, report.id)}
                  onConfirmed={() => {
                    setArchiving(false);
                    navigate(`/projects/${project.id}/reports`);
                  }}
                  onClose={() => setArchiving(false)}
                />
              )}
            </>
          );
        }}
      </Resource>
    </section>
  );
}
