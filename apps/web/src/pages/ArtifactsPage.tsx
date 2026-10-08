import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { RefreshCw, Search } from 'lucide-react';
import type { Artifact } from '@mmt/contracts';
import { registryApi } from '../api/registry';
import { trackingApi } from '../api/tracking';
import { useProject } from '../hooks/useProject';
import { useQuery } from '../hooks/useQuery';
import {
  useProjectArtifactCatalog,
  type ProjectArtifactFilter,
} from '../hooks/useProjectArtifacts';
import { PageHeader } from '../components/PageHeader';
import { DataTable } from '../components/DataTable';
import { ErrorNotice } from '../components/Feedback';
import { ArtifactPreview } from '../components/ArtifactPreview';
import { ARTIFACT_SEARCH_MAX_LENGTH } from '../lib/artifactCatalog';
import { formatBytes, formatDate } from '../lib/format';
import { text } from '../i18n/catalog';

// Recent Runs offered in the Run filter; older Runs are reached from their own page's link.
const RUN_FILTER_OPTION_LIMIT = 200;
// Run ids are UUIDs; the first block identifies a Run whose name is not loaded.
const SHORT_RUN_ID_LENGTH = 8;
const mimeTypeOptions = [
  ['', text.artifactMimeAll],
  ['audio/*', text.artifactMimeAudio],
  ['image/*', text.artifactMimeImage],
  ['video/*', text.artifactMimeVideo],
  ['text/*', text.artifactMimeText],
  ['application/*', text.artifactMimeApplication],
] as const;

/** Project-wide Artifact search with type, Run and model version filters, kept in the URL. */
export function ArtifactsPage() {
  const { project } = useProject();
  const [params, setParams] = useSearchParams();
  const filter: ProjectArtifactFilter = {
    query: params.get('query') ?? '',
    mimeType: params.get('mimeType') ?? '',
    runId: params.get('runId') ?? '',
    modelVersionId: params.get('modelVersionId') ?? '',
    includePreviousVersions: params.get('versions') === 'all',
  };
  const modelId = params.get('modelId') ?? '';
  const [searchInput, setSearchInput] = useState(filter.query);
  const [selected, setSelected] = useState<Artifact>();
  const catalog = useProjectArtifactCatalog(project.id, filter);
  const runs = useQuery(`${project.id}:artifact-filter-runs`, (signal) =>
    trackingApi.searchRuns(project.id, { limit: RUN_FILTER_OPTION_LIMIT }, signal),
  );
  const models = useQuery(`${project.id}:artifact-filter-models`, (signal) =>
    registryApi.models(project.id, signal),
  );
  const modelVersions = useQuery(
    modelId ? `${project.id}:artifact-filter-versions:${modelId}` : null,
    (signal) => registryApi.modelVersions(project.id, modelId, signal),
  );
  const runNames = new Map(runs.value?.items.map((run) => [run.id, run.name]));
  const base = `/projects/${project.id}`;

  function updateParams(values: Record<string, string>) {
    setParams((previous) => {
      const updated = new URLSearchParams(previous);
      for (const [key, value] of Object.entries(values))
        if (value) updated.set(key, value);
        else updated.delete(key);
      return updated;
    });
  }

  return (
    <section className="page artifact-catalog">
      <PageHeader
        title={text.artifacts}
        eyebrow={project.name}
        description={text.artifactCatalogDescription}
        actions={
          <button className="icon-button" aria-label={text.refresh} onClick={catalog.reload}>
            <RefreshCw size={17} />
          </button>
        }
      />
      <div className="run-toolbar artifact-catalog-toolbar">
        <form
          className="search-field"
          onSubmit={(event) => {
            event.preventDefault();
            updateParams({ query: searchInput.trim() });
          }}
        >
          <Search size={16} />
          <input
            aria-label={text.artifactCatalogSearch}
            placeholder={text.artifactCatalogSearch}
            maxLength={ARTIFACT_SEARCH_MAX_LENGTH}
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
          />
          <button className="button small" type="submit">
            {text.search}
          </button>
        </form>
        <label className="toolbar-select">
          <span>{text.artifactMimeType}</span>
          <select
            aria-label={text.artifactMimeType}
            value={filter.mimeType}
            onChange={(event) => updateParams({ mimeType: event.target.value })}
          >
            {mimeTypeOptions.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="toolbar-select">
          <span>{text.artifactRun}</span>
          <select
            aria-label={text.artifactRun}
            value={filter.runId}
            onChange={(event) => updateParams({ runId: event.target.value })}
          >
            <option value="">{text.artifactAllRuns}</option>
            {filter.runId && !runNames.has(filter.runId) && (
              <option value={filter.runId}>{filter.runId.slice(0, SHORT_RUN_ID_LENGTH)}</option>
            )}
            {runs.value?.items.map((run) => (
              <option key={run.id} value={run.id}>
                {run.name}
              </option>
            ))}
          </select>
        </label>
        <label className="toolbar-select">
          <span>{text.artifactModelFilter}</span>
          <select
            aria-label={text.artifactModelFilter}
            value={modelId}
            onChange={(event) => updateParams({ modelId: event.target.value, modelVersionId: '' })}
          >
            <option value="">{text.artifactAllModels}</option>
            {models.value?.map((model) => (
              <option key={model.id} value={model.id}>
                {model.name}
              </option>
            ))}
          </select>
        </label>
        {modelId && (
          <label className="toolbar-select">
            <span>{text.artifactModelVersionFilter}</span>
            <select
              aria-label={text.artifactModelVersionFilter}
              value={filter.modelVersionId}
              onChange={(event) => updateParams({ modelVersionId: event.target.value })}
            >
              <option value="">{text.none}</option>
              {modelVersions.value?.map((version) => (
                <option key={version.id} value={version.id}>
                  {version.version}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="toolbar-select">
          <input
            type="checkbox"
            checked={filter.includePreviousVersions}
            onChange={(event) => updateParams({ versions: event.target.checked ? 'all' : '' })}
          />
          <span>{text.artifactIncludePreviousVersions}</span>
        </label>
      </div>
      <ErrorNotice
        message={runs.error ?? models.error}
        retry={runs.error ? runs.reload : models.reload}
      />
      <div className="artifact-layout">
        <div>
          <DataTable
            items={catalog.items}
            rowKey={(item) => item.id}
            selectedKey={selected?.id}
            empty={catalog.loading ? text.loading : text.artifactNoCatalogResults}
            columns={[
              {
                key: 'path',
                label: text.artifactPath,
                render: (item) => (
                  <button className="link-button mono break-word" onClick={() => setSelected(item)}>
                    {item.path}
                  </button>
                ),
              },
              {
                key: 'run',
                label: text.artifactRun,
                render: (item) =>
                  item.runId ? (
                    <Link to={`${base}/runs/${item.runId}?tab=artifacts`}>
                      {runNames.get(item.runId) ?? item.runId.slice(0, SHORT_RUN_ID_LENGTH)}
                    </Link>
                  ) : (
                    <span className="muted">{text.artifactNoRun}</span>
                  ),
              },
              {
                key: 'mimeType',
                label: text.artifactMimeType,
                className: 'mono',
                render: (item) => item.mimeType.split(';')[0],
              },
              {
                key: 'size',
                label: text.size,
                className: 'mono',
                render: (item) => formatBytes(item.size),
              },
              {
                key: 'created',
                label: text.created,
                className: 'mono',
                render: (item) => formatDate(item.createdAt),
              },
            ]}
          />
          <ErrorNotice message={catalog.error} retry={catalog.reload} />
          {catalog.hasMore && (
            <button
              className="button artifact-load-more"
              disabled={catalog.loading}
              onClick={catalog.loadMore}
            >
              {text.artifactLoadMore}
            </button>
          )}
        </div>
        <section className="artifact-preview">
          {selected ? (
            <>
              <h3>{selected.path}</h3>
              <p className="mono muted">
                {selected.mimeType} · {formatBytes(selected.size)}
              </p>
              <ArtifactPreview key={selected.id} artifact={selected} />
            </>
          ) : (
            <p className="muted">{text.artifactSelectFile}</p>
          )}
        </section>
      </div>
    </section>
  );
}
