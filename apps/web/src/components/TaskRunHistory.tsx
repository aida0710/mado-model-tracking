import { Link } from 'react-router-dom';
import type { Run } from '@mmt/contracts';
import { ResponsiveTable } from './ResponsiveTable';
import { RunStatusBadge } from './runs/RunStatusBadge';
import { formatDate } from '../lib/format';
import { text } from '../i18n/catalog';

export function TaskRunHistory({ runs, projectId }: { runs: Run[]; projectId: string }) {
  return <ResponsiveTable rows={runs} rowKey={(run) => run.id} empty={text.noTaskRuns} columns={[
    { key: 'name', priority: 'primary', header: text.runName, render: (run) => <Link to={`/projects/${projectId}/runs/${run.id}`}>{run.name}</Link> },
    { key: 'revision', priority: 'secondary', header: text.taskRevision, render: (run) => run.taskRevision ?? '—' },
    { key: 'mode', priority: 'secondary', header: text.executionMode, render: (run) => run.executionMode === 'test' ? text.testMode : text.runMode },
    { key: 'status', priority: 'primary', header: text.status, render: (run) => <RunStatusBadge run={run} /> },
    { key: 'created', priority: 'secondary', header: text.created, render: (run) => formatDate(run.createdAt) },
  ]} />;
}
