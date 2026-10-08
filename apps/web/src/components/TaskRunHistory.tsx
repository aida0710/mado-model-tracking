import { Link } from 'react-router-dom';
import type { Run } from '@mmt/contracts';
import { DataTable } from './DataTable';
import { StatusBadge } from './StatusBadge';
import { formatDate } from '../lib/format';
import { text } from '../i18n/catalog';

export function TaskRunHistory({ runs, projectId }: { runs: Run[]; projectId: string }) {
  return <DataTable items={runs} rowKey={(run) => run.id} empty={text.noTaskRuns} columns={[
    { key: 'name', label: text.runName, render: (run) => <Link to={`/projects/${projectId}/runs/${run.id}`}>{run.name}</Link> },
    { key: 'revision', label: text.taskRevision, render: (run) => run.taskRevision ?? '—' },
    { key: 'mode', label: text.executionMode, render: (run) => run.executionMode === 'test' ? text.testMode : text.runMode },
    { key: 'status', label: text.status, render: (run) => <StatusBadge status={run.status} /> },
    { key: 'created', label: text.created, render: (run) => formatDate(run.createdAt) },
  ]} />;
}
