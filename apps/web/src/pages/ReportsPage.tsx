import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Plus, RefreshCw } from 'lucide-react';
import { REPORT_TITLE_MAX_LENGTH, type Report } from '@mmt/contracts';
import { reportsApi } from '../api/reports';
import { useProject } from '../hooks/useProject';
import { useReportList } from '../hooks/useReports';
import { PageHeader } from '../components/PageHeader';
import { DataTable } from '../components/DataTable';
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
    <section className="page reports-page" data-testid="reports-page">
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
        <DataTable
          items={reports.items}
          rowKey={(report) => report.id}
          empty={text.reportNone}
          columns={[
            {
              key: 'title',
              label: text.reportTitle,
              render: (report) => <Link to={reportPath(report)}>{report.title}</Link>,
            },
            { key: 'updatedBy', label: text.reportUpdatedBy, render: (report) => report.updatedBy.displayName },
            {
              key: 'updatedAt',
              label: text.reportUpdatedAt,
              className: 'nowrap',
              render: (report) => formatDate(report.updatedAt),
            },
            {
              key: 'revision',
              label: text.reportRevision,
              className: 'mono',
              render: (report) => textTemplates.reportRevisionLabel(report.currentRevision),
            },
            ...(includeArchived
              ? [
                  {
                    key: 'state',
                    label: text.reportState,
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
