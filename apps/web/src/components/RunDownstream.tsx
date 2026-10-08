import { Link } from 'react-router-dom';
import { useRunDownstream } from '../hooks/useRunDownstream';
import { ResponsiveTable } from './ResponsiveTable';
import { ErrorNotice } from './Feedback';
import { StatusBadge } from './StatusBadge';
import { formatDate, formatDuration } from '../lib/format';
import { text } from '../i18n/catalog';
import { automationText } from '../i18n/automation';

/** The Runs a Run started, such as the inference and evaluation that followed a training Run. */
export function RunDownstream({ projectId, runId }: { projectId: string; runId: string }) {
  const downstream = useRunDownstream(projectId, runId);
  const base = `/projects/${projectId}`;
  return (
    <section className="model-version-section" aria-label={text.runDownstream}>
      <h2>{text.runDownstream}</h2>
      <ErrorNotice message={downstream.error} retry={downstream.reload} />
      <ResponsiveTable
        rows={downstream.items}
        rowKey={(run) => run.id}
        empty={downstream.loading ? text.loading : text.runDownstreamEmpty}
        columns={[
          {
            key: 'name',
            priority: 'primary',
            header: text.name,
            render: (run) => <Link to={`${base}/runs/${run.id}`}>{run.name}</Link>,
          },
          { key: 'kind', priority: 'secondary', header: text.kind, render: (run) => text[run.kind] },
          {
            key: 'origin',
            priority: 'secondary',
            header: text.automationRule,
            render: (run) => (run.automatic ? automationText.automaticRun : automationText.manual),
          },
          { key: 'status', priority: 'primary', header: text.status, render: (run) => <StatusBadge status={run.status} /> },
          {
            key: 'version',
            priority: 'secondary',
            header: text.modelVersion,
            render: (run) =>
              run.modelVersionId ? (
                <Link className="mono" to={`${base}/models?version=${run.modelVersionId}`}>
                  {run.modelVersionId}
                </Link>
              ) : (
                '—'
              ),
          },
          { key: 'created', priority: 'secondary', header: text.created, render: (run) => formatDate(run.createdAt) },
          {
            key: 'duration',
            priority: 'secondary',
            header: text.duration,
            render: (run) => formatDuration(run.startedAt, run.endedAt),
          },
        ]}
      />
      {downstream.hasMore && (
        <button className="button small" disabled={downstream.loading} onClick={downstream.loadMore}>
          {text.loadMore}
        </button>
      )}
    </section>
  );
}
