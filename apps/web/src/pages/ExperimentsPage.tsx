import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Plus, RefreshCw } from 'lucide-react';
import type { RunSearchRequest, RunStatus } from '@mmt/contracts';
import { trackingApi } from '../api/tracking';
import { useProject } from '../hooks/useProject';
import { useQuery } from '../hooks/useQuery';
import { useRunSearch } from '../hooks/useRunSearch';
import { useMutation } from '../hooks/useMutation';
import { PageHeader } from '../components/PageHeader';
import { ErrorNotice, Resource } from '../components/Feedback';
import { FormDialog } from '../components/FormDialog';
import { ExperimentSidebar } from '../components/runs/ExperimentSidebar';
import { RunToolbar } from '../components/runs/RunToolbar';
import { RunTable } from '../components/runs/RunTable';
import { RunSelectionBar } from '../components/runs/RunSelectionBar';
import { RunPagination } from '../components/runs/RunPagination';
import { getRunColumnNames } from '../components/runs/runColumnNames';
import { RunDialog } from '../dialogs/RunDialog';
import { getFieldValue } from '../lib/formValues';
import { downloadBlob } from '../lib/fileDownload';
import { runSortOrderBy, toRunSearchConditions } from '../lib/runFilter';
import { text } from '../i18n/catalog';

// A compact page keeps wide parameter and metric columns usable on a laptop.
const RUNS_PER_PAGE = 25;
// Two of each keep the initial comparison readable before the user picks more columns.
const DEFAULT_METRIC_COLUMNS = 2;
const DEFAULT_PARAMETER_COLUMNS = 2;
const baseColumnNames = ['status', 'created', 'duration', 'user', 'kind'] as const;
// URL parameter holding the cursors that led to the shown page, oldest first. Cursors are
// base64url, so a comma never appears inside one.
const CURSOR_HISTORY_PARAM = 'cursors';
const CURSOR_SEPARATOR = ',';

export function ExperimentsPage() {
  const { project, canEdit } = useProject();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const experimentId = params.get('experiment') ?? '';
  const searchText = params.get('q') ?? '';
  const status = params.get('status') ?? '';
  const sort = params.get('sort') ?? 'newest';
  const cursorHistory = (params.get(CURSOR_HISTORY_PARAM) ?? '')
    .split(CURSOR_SEPARATOR)
    .filter(Boolean);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [columnVisibility, setColumnVisibility] = useState<Record<string, boolean>>({});
  const [dialog, setDialog] = useState<'experiment' | 'run' | 'tag' | null>(null);
  const mutation = useMutation();
  const csvExport = useMutation();
  const [isExportTruncated, setIsExportTruncated] = useState(false);
  useEffect(() => setSelectedIds([]), [experimentId, searchText, status]);
  const experiments = useQuery(`${project.id}:experiments`, (signal) =>
    trackingApi.experiments(project.id, signal),
  );
  const cursor = cursorHistory.at(-1);
  const search: RunSearchRequest = {
    ...toRunSearchConditions(searchText),
    ...(experimentId ? { experimentIds: [experimentId] } : {}),
    ...(status ? { statuses: [status as RunStatus] } : {}),
    orderBy: runSortOrderBy(sort),
    limit: RUNS_PER_PAGE,
    ...(cursor ? { cursor } : {}),
  };
  const runs = useRunSearch(project.id, search);
  async function exportSearchCsv() {
    setIsExportTruncated(false);
    // The export covers the whole search; paging fields would be ignored by the API anyway.
    const { limit: _limit, cursor: _cursor, ...conditions } = search;
    const exported = await csvExport.run(() =>
      trackingApi.exportRunSearchCsv(project.id, conditions),
    );
    if (!exported) return;
    downloadBlob(exported.blob, exported.fileName);
    setIsExportTruncated(exported.truncated);
  }
  const experiment = experiments.value?.find((item) => item.id === experimentId);
  const shownRuns = runs.value?.items ?? [];
  const { metricNames, parameterNames } = getRunColumnNames(shownRuns);
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
  // Any change of conditions starts again from the first page; a cursor belongs to one search.
  function updateParams(updates: Record<string, string>) {
    setParams((previous) => {
      const next = new URLSearchParams(previous);
      for (const [key, value] of Object.entries(updates)) {
        if (value) next.set(key, value);
        else next.delete(key);
      }
      if (!(CURSOR_HISTORY_PARAM in updates)) next.delete(CURSOR_HISTORY_PARAM);
      return next;
    });
  }
  const showCursorHistory = (history: string[]) =>
    updateParams({ [CURSOR_HISTORY_PARAM]: history.join(CURSOR_SEPARATOR) });
  function reload() {
    experiments.reload();
    runs.reload();
  }

  return (
    <div className="experiments-layout">
      <ExperimentSidebar
        experiments={experiments}
        selectedExperimentId={experimentId}
        canEdit={canEdit}
        onSelect={(id) => updateParams({ experiment: id })}
        onCreate={() => setDialog('experiment')}
      />
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
        <RunToolbar
          searchText={searchText}
          status={status}
          sort={sort}
          metricNames={metricNames}
          columnNames={[
            ...baseColumnNames,
            ...metricNames.map((name) => `metrics.${name}`),
            ...parameterNames.map((name) => `params.${name}`),
          ]}
          isColumnVisible={isColumnVisible}
          onSearch={(value) => updateParams({ q: value })}
          onStatusChange={(value) => updateParams({ status: value })}
          onSortChange={(value) => updateParams({ sort: value })}
          onColumnToggle={(name) =>
            setColumnVisibility((current) => ({ ...current, [name]: !isColumnVisible(name) }))
          }
          exportingCsv={csvExport.pending}
          onExportCsv={() => void exportSearchCsv()}
        />
        <ErrorNotice message={mutation.error} />
        <ErrorNotice message={csvExport.error} />
        {isExportTruncated && (
          <p className="notice" role="status">
            {text.exportRunsTruncated}
          </p>
        )}
        <Resource query={runs}>
          {(page) => (
            <>
              <RunSelectionBar
                projectId={project.id}
                selectedIds={selectedIds}
                canEdit={canEdit}
                onAddTag={() => setDialog('tag')}
                onClear={() => setSelectedIds([])}
              />
              <RunTable
                projectId={project.id}
                runs={page.items}
                metricNames={metricNames}
                parameterNames={parameterNames}
                isColumnVisible={isColumnVisible}
                selectedIds={selectedIds}
                onSelectedIdsChange={setSelectedIds}
              />
              <RunPagination
                pageNumber={cursorHistory.length + 1}
                shownCount={page.items.length}
                pageSize={RUNS_PER_PAGE}
                hasNextPage={page.nextCursor !== null}
                onFirst={() => showCursorHistory([])}
                onPrevious={() => showCursorHistory(cursorHistory.slice(0, -1))}
                onNext={() =>
                  page.nextCursor && showCursorHistory([...cursorHistory, page.nextCursor])
                }
              />
            </>
          )}
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
