import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Plus, RefreshCw } from 'lucide-react';
import { REPORT_TITLE_MAX_LENGTH, type Report } from '@mmt/contracts';
import { reportsApi } from '../api/reports';
import { useProject } from '../hooks/useProject';
import { useReportList } from '../hooks/useReports';
import { PageHeader } from '../components/PageHeader';
import { ResponsiveTable } from '../components/ResponsiveTable';
import { ErrorNotice, Loading } from '../components/Feedback';
import { FormDialog } from '../components/FormDialog';
import { formatDate } from '../lib/format';
import type { ReportPageLocationState } from './ReportPage';
import { text, textTemplates } from '../i18n/catalog';

const SHOW_ARCHIVED_PARAM = 'archived';

/** The Project's shared reports. Editors create one here and continue in its editor. */
export function ReportsPage() {
  const { project, canEdit } = useProject();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const includeArchived = params.get(SHOW_ARCHIVED_PARAM) === '1';
  const [isCreating, setCreating] = useState(false);
  const reports = useReportList(project.id, includeArchived);
  const reportPath = (report: Report) => `/projects/${project.id}/reports/${report.id}`;

  return (
    <section className="page reports-page touch-targets" data-testid="reports-page">
      <PageHeader
        title={text.reports}
        eyebrow={project.name}
        actions={
          <>
            {canEdit && (
              <button className="button primary" onClick={() => setCreating(true)}>
                <Plus size={15} />
                {text.reportNew}
              </button>
            )}
            <button className="icon-button" aria-label={text.refresh} onClick={reports.reload}>
              <RefreshCw size={17} />
            </button>
          </>
        }
      />
      <label className="checkbox-field">
        <input
          type="checkbox"
          checked={includeArchived}
          onChange={(event) => setParams(event.target.checked ? { [SHOW_ARCHIVED_PARAM]: '1' } : {})}
        />
        {text.reportShowArchived}
      </label>
      <ErrorNotice message={reports.error} retry={reports.reload} />
      {reports.loading && !reports.items.length ? (
        <Loading />
      ) : (
        <ResponsiveTable
          rows={reports.items}
          rowKey={(report) => report.id}
          empty={text.reportNone}
          columns={[
            {
              key: 'title',
              header: text.reportTitle,
              priority: 'primary',
              className: 'break-word',
              render: (report) => <Link to={reportPath(report)}>{report.title}</Link>,
            },
            {
              key: 'updatedBy',
              header: text.reportUpdatedBy,
              priority: 'secondary',
              render: (report) => report.updatedBy.displayName,
            },
            {
              key: 'updatedAt',
              header: text.reportUpdatedAt,
              priority: 'primary',
              className: 'nowrap',
              render: (report) => formatDate(report.updatedAt),
            },
            {
              key: 'revision',
              header: text.reportRevision,
              priority: 'secondary',
              className: 'mono',
              render: (report) => textTemplates.reportRevisionLabel(report.currentRevision),
            },
            ...(includeArchived
              ? [
                  {
                    key: 'state',
                    header: text.reportState,
                    priority: 'secondary' as const,
                    render: (report: Report) => (report.archivedAt ? text.reportArchived : text.reportActive),
                  },
                ]
              : []),
          ]}
        />
      )}
      {reports.hasMore && (
        <button className="button small" disabled={reports.loading} onClick={reports.loadMore}>
          {text.loadMore}
        </button>
      )}
      {isCreating && (
        <FormDialog
          title={text.reportNew}
          submitLabel={text.create}
          fields={[{ name: 'title', label: text.reportTitle, required: true, maxLength: REPORT_TITLE_MAX_LENGTH }]}
          onSubmit={(values) => reportsApi.create(project.id, { title: String(values.title).trim(), blocks: [] })}
          onSaved={(created) => {
            const state: ReportPageLocationState = { edit: true };
            navigate(`/projects/${project.id}/reports/${created.report.id}`, { state });
          }}
          onClose={() => setCreating(false)}
        />
      )}
    </section>
  );
}
