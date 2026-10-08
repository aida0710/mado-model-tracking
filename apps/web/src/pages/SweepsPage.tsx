import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Plus, RefreshCw } from 'lucide-react';
import type { ExperimentTask, Sweep, SweepStatus } from '@mmt/contracts';
import { accessApi } from '../api/access';
import { executionApi } from '../api/execution';
import { tasksApi } from '../api/tasks';
import { trackingApi } from '../api/tracking';
import { useProject } from '../hooks/useProject';
import { useQuery } from '../hooks/useQuery';
import { useSweepList } from '../hooks/useSweeps';
import { formatDate, formatNumber } from '../lib/format';
import { PageHeader } from '../components/PageHeader';
import { DataTable } from '../components/DataTable';
import { ErrorNotice, Loading, Resource } from '../components/Feedback';
import { CreateSweepDialog } from '../components/sweeps/CreateSweepDialog';
import { SweepStatusBadge } from '../components/sweeps/SweepSummary';
import { sweepMethodLabels, sweepStatusLabels } from '../i18n/sweeps';
import { text, textTemplates } from '../i18n/catalog';

const STATUS_FILTERS = Object.keys(sweepStatusLabels) as SweepStatus[];

export function SweepsPage() {
  const { project, canEdit } = useProject();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const status = (STATUS_FILTERS as string[]).includes(params.get('status') ?? '') ? (params.get('status') as SweepStatus) : '';
  const [isCreating, setCreating] = useState(false);
  const sweeps = useSweepList(project.id, status);
  const tasks = useQuery(`${project.id}:sweep-tasks`, (signal) => tasksApi.list(project.id, undefined, signal));
  // Names for the list; a failed lookup only falls back to ids, so these do not block the page.
  const members = useQuery(`${project.id}:sweep-members`, (signal) => accessApi.members(project.id, signal));
  const taskName = (sweep: Sweep) => tasks.value?.find((task) => task.id === sweep.taskId)?.name ?? sweep.taskId;
  const creatorName = (sweep: Sweep) =>
    members.value?.find((member) => member.user.id === sweep.createdBy)?.user.displayName ?? sweep.createdBy;
  const sweepPath = (sweep: Sweep) => `/projects/${project.id}/sweeps/${sweep.id}`;

  return (
    <section className="page sweeps-page" data-testid="sweeps-page">
      <PageHeader title={text.sweeps} eyebrow={project.name} actions={<>
        {canEdit && (
          <button className="button primary" onClick={() => setCreating(true)}>
            <Plus size={15} />{text.sweepNew}
          </button>
        )}
        <button className="icon-button" aria-label={text.refresh} onClick={() => { sweeps.reload(); tasks.reload(); }}>
          <RefreshCw size={17} />
        </button>
      </>} />
      <label className="chart-selector">
        <span>{text.status}</span>
        <select aria-label={text.status} value={status}
          onChange={(event) => setParams(event.target.value ? { status: event.target.value } : {})}>
          <option value="">{text.allStatus}</option>
          {STATUS_FILTERS.map((item) => <option key={item} value={item}>{sweepStatusLabels[item]}</option>)}
        </select>
      </label>
      <ErrorNotice message={sweeps.error} retry={sweeps.reload} />
      {sweeps.loading && !sweeps.items.length ? <Loading /> : (
        <DataTable
          items={sweeps.items}
          rowKey={(sweep) => sweep.id}
          empty={text.sweepNone}
          columns={[
            { key: 'name', label: text.name, render: (sweep) => <Link to={sweepPath(sweep)}>{sweep.name}</Link> },
            { key: 'task', label: text.sweepTask, render: taskName },
            { key: 'method', label: text.sweepMethod, render: (sweep) => sweepMethodLabels[sweep.method] },
            { key: 'status', label: text.status, render: (sweep) => <SweepStatusBadge status={sweep.status} /> },
            {
              key: 'trials',
              label: text.sweepTrials,
              className: 'mono',
              render: (sweep) => textTemplates.sweepTrialProgress(sweep.trialCounts.total, sweep.maxTrials),
            },
            {
              key: 'running',
              label: text.sweepRunningTrials,
              className: 'mono',
              render: (sweep) => sweep.trialCounts.queued + sweep.trialCounts.running,
            },
            {
              key: 'best',
              label: text.sweepBestObjective,
              className: 'mono',
              render: (sweep) => {
                const best = sweep.bestTrial?.objectiveValue ?? null;
                return best === null ? '—' : `${formatNumber(best)}（${sweep.objective.metric}）`;
              },
            },
            { key: 'createdBy', label: text.sweepCreatedBy, render: creatorName },
            { key: 'created', label: text.created, render: (sweep) => formatDate(sweep.createdAt) },
          ]}
        />
      )}
      {sweeps.hasMore && (
        <button className="button small" disabled={sweeps.loading} onClick={sweeps.loadMore}>{text.loadMore}</button>
      )}
      {isCreating && (
        <Resource query={tasks}>
          {(taskItems) => (
            <CreateSweepDialogLoader
              projectId={project.id}
              onClose={() => setCreating(false)}
              onCreated={(sweep) => navigate(sweepPath(sweep))}
              tasks={taskItems}
            />
          )}
        </Resource>
      )}
    </section>
  );
}

/** Reads the Experiments and targets the dialog shows before opening it. */
function CreateSweepDialogLoader({
  projectId,
  tasks,
  onClose,
  onCreated,
}: {
  projectId: string;
  tasks: ExperimentTask[];
  onClose: () => void;
  onCreated: (sweep: Sweep) => void;
}) {
  const experiments = useQuery(`${projectId}:sweep-experiments`, (signal) => trackingApi.experiments(projectId, signal));
  const targets = useQuery('sweep-targets', executionApi.targets);
  return (
    <Resource query={experiments}>
      {(experimentItems) => (
        <Resource query={targets}>
          {(targetItems) => (
            <CreateSweepDialog projectId={projectId} tasks={tasks} experiments={experimentItems} targets={targetItems}
              onClose={onClose} onCreated={onCreated} />
          )}
        </Resource>
      )}
    </Resource>
  );
}
