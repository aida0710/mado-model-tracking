import { Link } from 'react-router-dom';
import type { Run } from '@mmt/contracts';
import { DataTable, type TableColumn } from '../DataTable';
import { StatusBadge } from '../StatusBadge';
import { CompactValue } from '../CompactValue';
import { getRunParameters } from '../../lib/runParameters';
import { formatDate, formatDuration } from '../../lib/format';
import { text } from '../../i18n/catalog';

export function RunTable({
  projectId,
  runs,
  metricNames,
  parameterNames,
  isColumnVisible,
  selectedIds,
  onSelectedIdsChange,
}: {
  projectId: string;
  runs: Run[];
  metricNames: string[];
  parameterNames: string[];
  isColumnVisible: (name: string) => boolean;
  selectedIds: string[];
  onSelectedIdsChange: (ids: string[]) => void;
}) {
  const allShownSelected = runs.length > 0 && runs.every((run) => selectedIds.includes(run.id));
  function toggleRun(id: string) {
    onSelectedIdsChange(
      selectedIds.includes(id)
        ? selectedIds.filter((selected) => selected !== id)
        : [...selectedIds, id],
    );
  }
  function toggleShownRuns(selected: boolean) {
    onSelectedIdsChange(
      selected
        ? Array.from(new Set([...selectedIds, ...runs.map((run) => run.id)]))
        : selectedIds.filter((id) => !runs.some((run) => run.id === id)),
    );
  }
  const columns: TableColumn<Run>[] = [
    {
      key: 'selection',
      label: (
        <input
          type="checkbox"
          aria-label={text.selectAll}
          checked={allShownSelected}
          onChange={(event) => toggleShownRuns(event.target.checked)}
        />
      ),
      render: (run) => (
        <input
          type="checkbox"
          aria-label={`${text.selectRun}: ${run.name}`}
          checked={selectedIds.includes(run.id)}
          onChange={() => toggleRun(run.id)}
        />
      ),
    },
    {
      key: 'name',
      label: text.runName,
      render: (run) => (
        <Link className="run-name" title={run.name} to={`/projects/${projectId}/runs/${run.id}`}>
          {run.name}
        </Link>
      ),
    },
    {
      key: 'status',
      label: text.status,
      render: (run) => <StatusBadge status={run.status} />,
    },
    {
      key: 'created',
      label: text.created,
      render: (run) => formatDate(run.createdAt),
      className: 'nowrap',
    },
    {
      key: 'duration',
      label: text.duration,
      render: (run) => formatDuration(run.startedAt, run.endedAt),
      className: 'mono nowrap',
    },
    ...metricNames.map((name) => ({
      key: `metrics.${name}`,
      label: (
        <>
          <small>{text.metrics}</small>
          <span className="run-column-name" title={name}>
            {name}
          </span>
        </>
      ),
      render: (run: Run) => <CompactValue value={run.latestMetrics[name]} />,
      className: 'mono numeric',
    })),
    ...parameterNames.map((name) => ({
      key: `params.${name}`,
      label: (
        <>
          <small>{text.parameters}</small>
          <span className="run-column-name" title={name}>
            {name}
          </span>
        </>
      ),
      render: (run: Run) => <CompactValue value={getRunParameters(run)[name]} />,
      className: 'mono',
    })),
    {
      key: 'user',
      label: text.user,
      render: (run) => (
        <span className="run-user" title={run.createdBy}>
          {run.createdBy}
        </span>
      ),
    },
    {
      key: 'kind',
      label: text.kind,
      render: (run) => text[run.kind],
      className: 'nowrap',
    },
  ];
  return (
    <DataTable
      isSelected={(run) => selectedIds.includes(run.id)}
      items={runs}
      columns={columns.filter((column) => isColumnVisible(column.key))}
      rowKey={(run) => run.id}
      empty={text.noResults}
    />
  );
}
