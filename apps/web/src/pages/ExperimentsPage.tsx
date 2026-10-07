import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Columns3, Plus, RefreshCw, Search } from 'lucide-react';
import type { Run } from '@mmt/contracts';
import { trackingApi } from '../api/tracking';
import { useProject } from '../hooks/useProject';
import { EXECUTION_POLL_MS, useQuery } from '../hooks/useQuery';
import { RUN_LIST_LIMIT } from '../hooks/useExecutionCatalog';
import { useMutation } from '../hooks/useMutation';
import { DataTable, type TableColumn } from '../components/DataTable';
import { PageHeader } from '../components/PageHeader';
import { Empty, ErrorNotice, Resource } from '../components/Feedback';
import { FormDialog } from '../components/FormDialog';
import { StatusBadge } from '../components/StatusBadge';
import { CompactValue } from '../components/CompactValue';
import { RunDialog } from '../dialogs/RunDialog';
import { formatDate, formatDuration } from '../lib/format';
import { getFieldValue } from '../lib/formValues';
import { matchesRunFilter, parseRunFilter, type RunFilter } from '../lib/runFilter';
import { text } from '../i18n/catalog';

// A compact page keeps wide parameter and metric columns usable on a laptop.
const RUNS_PER_PAGE = 25;
// Two of each keep the initial comparison readable before the user picks more columns.
const DEFAULT_METRIC_COLUMNS = 2;
const DEFAULT_PARAMETER_COLUMNS = 2;
// Experiment metrics belong in the initial columns, alongside the execution settings.
const SYSTEM_METRIC_PREFIX = 'system.';
const baseColumnNames = ['status', 'created', 'duration', 'user', 'kind'] as const;

export function ExperimentsPage() {
  const { project, canEdit } = useProject();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const experimentId = params.get('experiment') ?? '';
  const queryText = params.get('q') ?? '';
  const status = params.get('status') ?? '';
  const sort = params.get('sort') ?? 'newest';
  const pageIndex = Math.max(0, Number(params.get('page') ?? 0) || 0);
  const [searchInput, setSearchInput] = useState(queryText);
  const [experimentSearch, setExperimentSearch] = useState('');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [columnVisibility, setColumnVisibility] = useState<Record<string, boolean>>({});
  const [dialog, setDialog] = useState<'experiment' | 'run' | 'tag' | null>(null);
  const mutation = useMutation();
  useEffect(() => setSearchInput(queryText), [queryText]);
  useEffect(() => setSelectedIds([]), [experimentId, queryText, status]);
  const experiments = useQuery(`${project.id}:experiments`, (signal) =>
    trackingApi.experiments(project.id, signal),
  );
  let filter: RunFilter = { search: '', comparisons: [] };
  let filterError: string | null = null;
  try {
    filter = parseRunFilter(queryText);
  } catch (error) {
    filterError = (error as Error).message;
  }
  const runsQuery = {
    ...(experimentId ? { experimentId } : {}),
    ...(status ? { status } : {}),
    ...(filter.search ? { q: filter.search } : {}),
    limit: String(RUN_LIST_LIMIT),
  };
  const runs = useQuery(
    `${project.id}:runs:${JSON.stringify(runsQuery)}`,
    (signal) => trackingApi.runs(project.id, runsQuery, signal),
    EXECUTION_POLL_MS,
  );
  const experiment = experiments.value?.find((item) => item.id === experimentId);
  const parameterNames = Array.from(
    new Set((runs.value ?? []).flatMap((run) => Object.keys(run.parameters))),
  ).sort();
  const metricNames = Array.from(
    new Set((runs.value ?? []).flatMap((run) => Object.keys(run.latestMetrics))),
  ).sort(
    (left, right) =>
      Number(left.startsWith(SYSTEM_METRIC_PREFIX)) -
        Number(right.startsWith(SYSTEM_METRIC_PREFIX)) || left.localeCompare(right),
  );
  const defaultColumns = new Set([
    'selection',
    'name',
    'status',
    'created',
    'duration',
    'user',
    ...metricNames.slice(0, DEFAULT_METRIC_COLUMNS).map((name) => `metrics.${name}`),
    ...parameterNames.slice(0, DEFAULT_PARAMETER_COLUMNS).map((name) => `params.${name}`),
  ]);
  const isColumnVisible = (name: string) => columnVisibility[name] ?? defaultColumns.has(name);
  function updateParams(updates: Record<string, string>) {
    setParams((previous) => {
      const next = new URLSearchParams(previous);
      for (const [key, value] of Object.entries(updates)) {
        if (value) next.set(key, value);
        else next.delete(key);
      }
      if (!('page' in updates)) next.delete('page');
      return next;
    });
  }
  function toggleRun(id: string) {
    setSelectedIds((ids) =>
      ids.includes(id) ? ids.filter((selected) => selected !== id) : [...ids, id],
    );
  }
  function reload() {
    experiments.reload();
    runs.reload();
  }

  return (
    <div className="experiments-layout">
      <aside className="experiment-sidebar">
        <div className="sidebar-heading">
          <span>{text.experiments}</span>
          {canEdit && (
            <button
              className="icon-button"
              aria-label={text.newExperiment}
              onClick={() => setDialog('experiment')}
            >
              <Plus size={18} />
            </button>
          )}
        </div>
        <input
          className="sidebar-search"
          aria-label={text.filterExperiments}
          placeholder={text.filterExperiments}
          value={experimentSearch}
          onChange={(event) => setExperimentSearch(event.target.value)}
        />
        <button
          className={`experiment-item ${!experimentId ? 'active' : ''}`}
          onClick={() => updateParams({ experiment: '' })}
        >
          {text.allExperiments}
        </button>
        <Resource query={experiments}>
          {(items) => (
            <>
              {items
                .filter((item) => item.name.toLowerCase().includes(experimentSearch.toLowerCase()))
                .map((item) => (
                  <button
                    key={item.id}
                    className={`experiment-item ${item.id === experimentId ? 'active' : ''}`}
                    onClick={() => updateParams({ experiment: item.id })}
                  >
                    <span>{item.name}</span>
                    <small>{item.runCount} runs</small>
                  </button>
                ))}
              {!items.length && <Empty />}
            </>
          )}
        </Resource>
      </aside>
      <section className="page runs-page">
        <PageHeader
          title={experiment?.name ?? text.runs}
          eyebrow={
            <>
              {text.experiments}
              <span className="breadcrumb-separator">/</span>
              {project.name}
            </>
          }
          description={
            experiment ? <span className="mono">ID {experiment.id}</span> : project.description
          }
          actions={
            <>
              {canEdit && (
                <button className="button primary" onClick={() => setDialog('run')}>
                  <Plus size={15} />
                  {text.newRun}
                </button>
              )}
              <button className="icon-button" onClick={reload} aria-label={text.refresh}>
                <RefreshCw size={17} />
              </button>
            </>
          }
        />
        <div className="tabs">
          <span className="tab active">{text.runs}</span>
          <Link className="tab" to={`/projects/${project.id}/lineage`}>
            {text.lineage}
          </Link>
        </div>
        <div className="run-toolbar">
          <form
            className="search-field"
            onSubmit={(event) => {
              event.preventDefault();
              updateParams({ q: searchInput });
            }}
          >
            <Search size={16} />
            <input
              aria-label={text.search}
              placeholder={text.queryHint}
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
            />
            <button className="button small" type="submit">
              {text.filter}
            </button>
          </form>
          <label className="toolbar-select">
            <span>{text.status}</span>
            <select
              aria-label={text.status}
              value={status}
              onChange={(event) => updateParams({ status: event.target.value })}
            >
              <option value="">{text.allStatus}</option>
              {(['queued', 'running', 'finished', 'failed', 'canceled'] as const).map((value) => (
                <option key={value} value={value}>
                  {text[value]}
                </option>
              ))}
            </select>
          </label>
          <details className="column-menu">
            <summary>
              <Columns3 size={15} />
              {text.columns}
            </summary>
            <div className="popover">
              {[
                ...baseColumnNames,
                ...metricNames.map((name) => `metrics.${name}`),
                ...parameterNames.map((name) => `params.${name}`),
              ].map((name) => (
                <label key={name}>
                  <input
                    type="checkbox"
                    checked={isColumnVisible(name)}
                    onChange={() =>
                      setColumnVisibility((current) => ({
                        ...current,
                        [name]: !isColumnVisible(name),
                      }))
                    }
                  />
                  {name in text ? text[name as keyof typeof text] : name}
                </label>
              ))}
            </div>
          </details>
          <label className="toolbar-select">
            <span>{text.sort}</span>
            <select
              aria-label={text.sort}
              value={sort}
              onChange={(event) => updateParams({ sort: event.target.value })}
            >
              <option value="newest">{text.newest}</option>
              <option value="oldest">{text.oldest}</option>
              <option value="name">{text.byName}</option>
            </select>
          </label>
        </div>
        <ErrorNotice message={filterError} />
        <ErrorNotice message={mutation.error} />
        <Resource query={runs}>
          {(items) => {
            const filtered = filterError
              ? []
              : items
                  .filter((run) => matchesRunFilter(run, filter))
                  .sort((left, right) =>
                    sort === 'name'
                      ? left.name.localeCompare(right.name)
                      : sort === 'oldest'
                        ? left.createdAt.localeCompare(right.createdAt)
                        : right.createdAt.localeCompare(left.createdAt),
                  );
            const totalPages = Math.max(1, Math.ceil(filtered.length / RUNS_PER_PAGE));
            const currentPage = Math.min(pageIndex, totalPages - 1);
            const visibleRuns = filtered.slice(
              currentPage * RUNS_PER_PAGE,
              (currentPage + 1) * RUNS_PER_PAGE,
            );
            const columns: TableColumn<Run>[] = [
              {
                key: 'selection',
                label: (
                  <input
                    type="checkbox"
                    aria-label={text.selectAll}
                    checked={
                      visibleRuns.length > 0 &&
                      visibleRuns.every((run) => selectedIds.includes(run.id))
                    }
                    onChange={(event) =>
                      setSelectedIds(
                        event.target.checked
                          ? Array.from(
                              new Set([...selectedIds, ...visibleRuns.map((run) => run.id)]),
                            )
                          : selectedIds.filter((id) => !visibleRuns.some((run) => run.id === id)),
                      )
                    }
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
                  <Link
                    className="run-name"
                    title={run.name}
                    to={`/projects/${project.id}/runs/${run.id}`}
                  >
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
                render: (run: Run) => <CompactValue value={run.parameters[name]} />,
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
              <>
                {selectedIds.length > 0 && (
                  <div className="selection-bar">
                    <span>
                      {selectedIds.length} runs · {text.selectedRuns}
                    </span>
                    <div>
                      <button
                        disabled={selectedIds.length < 2}
                        onClick={() =>
                          navigate(`/projects/${project.id}/compare?runs=${selectedIds.join(',')}`)
                        }
                      >
                        {text.compare}
                      </button>
                      {canEdit && <button onClick={() => setDialog('tag')}>{text.addTag}</button>}
                      <button onClick={() => setSelectedIds([])}>{text.clearSelection}</button>
                    </div>
                  </div>
                )}
                <DataTable
                  isSelected={(run) => selectedIds.includes(run.id)}
                  items={visibleRuns}
                  columns={columns.filter((column) => isColumnVisible(column.key))}
                  rowKey={(run) => run.id}
                  empty={text.noResults}
                />
                <div className="table-footer">
                  <span>
                    {filtered.length} runs · {RUNS_PER_PAGE} / {text.page}
                  </span>
                  <span>
                    {currentPage + 1} / {totalPages}
                    <button
                      className="icon-button"
                      disabled={currentPage === 0}
                      aria-label={text.previousPage}
                      onClick={() => updateParams({ page: String(currentPage - 1) })}
                    >
                      ‹
                    </button>
                    <button
                      className="icon-button"
                      disabled={currentPage >= totalPages - 1}
                      aria-label={text.nextPage}
                      onClick={() => updateParams({ page: String(currentPage + 1) })}
                    >
                      ›
                    </button>
                  </span>
                </div>
                {items.length >= RUN_LIST_LIMIT && <p className="muted">{text.resultsLimit}</p>}
              </>
            );
          }}
        </Resource>
      </section>
      {dialog === 'experiment' && (
        <FormDialog
          title={text.newExperiment}
          fields={[
            { name: 'name', label: text.name, required: true },
            { name: 'description', label: text.description, type: 'textarea' },
          ]}
          onClose={() => setDialog(null)}
          onSubmit={(values) =>
            trackingApi.createExperiment(project.id, {
              name: getFieldValue(values, 'name'),
              description: getFieldValue(values, 'description'),
            })
          }
          onSaved={(saved) => {
            setDialog(null);
            reload();
            updateParams({ experiment: saved.id });
          }}
        />
      )}
      {dialog === 'run' && (
        <RunDialog
          experimentId={experimentId}
          onClose={() => setDialog(null)}
          onSaved={(saved) => {
            setDialog(null);
            navigate(`/projects/${project.id}/runs/${saved.id}`);
          }}
        />
      )}
      {dialog === 'tag' && (
        <FormDialog
          title={text.addTag}
          fields={[
            { name: 'key', label: text.tagKey, required: true },
            { name: 'value', label: text.tagValue, required: true },
          ]}
          onClose={() => setDialog(null)}
          onSubmit={async (values) => {
            // Fetch current tags before merging so a stale polling snapshot cannot erase another edit.
            for (const id of selectedIds) {
              const run = await trackingApi.run(project.id, id);
              await trackingApi.updateRun(project.id, id, {
                tags: {
                  ...run.tags,
                  [getFieldValue(values, 'key')]: getFieldValue(values, 'value'),
                },
              });
            }
            return true;
          }}
          onSaved={() => {
            setDialog(null);
            reload();
          }}
        />
      )}
    </div>
  );
}
