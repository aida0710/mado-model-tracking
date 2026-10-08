import type {
  Artifact,
  ArtifactListVersions,
  ArtifactPage,
  ArtifactTree,
  Experiment,
  LineageGraph,
  LogEntry,
  MetricPoint,
  Run,
  RunComparison,
  RunComparisonRequest,
  RunSearchPage,
  RunSearchRequest,
} from '@mmt/contracts';
import { RUN_EXPORT_TRUNCATED_HEADER } from '@mmt/contracts';
import type { CreateRun, UpdateRun } from './inputs';
import {
  ARTIFACT_CONTENT_UNAVAILABLE_CODE,
  encodeId,
  invalidResponseError,
  NETWORK_ERROR_CODE,
  jsonRequest,
  projectPath,
  request,
  RequestError,
  requestItems,
} from './http';

const artifactContentPath = (projectId: string, artifactId: string) =>
  `${projectPath(projectId)}/artifacts/${encodeId(artifactId)}/content`;

const runPath = (projectId: string, runId: string) =>
  `${projectPath(projectId)}/runs/${encodeId(runId)}`;

export interface RunArtifactPageQuery {
  prefix?: string;
  /** Only files directly under prefix (the API's `delimiter=/`). */
  directFilesOnly?: boolean;
  versions?: ArtifactListVersions;
  limit?: number;
  cursor?: string;
}

export interface ProjectArtifactPageQuery {
  limit: number;
  query?: string;
  /** `type/subtype` or `type/*`. */
  mimeType?: string;
  runId?: string;
  modelVersionId?: string;
  /** Every version of the Model; with modelVersionId as well, that version only. */
  modelId?: string;
  versions?: ArtifactListVersions;
  cursor?: string;
}

/** Drops unset values so the API applies its own defaults. */
function searchParams(values: Record<string, string | number | boolean | undefined>): string {
  const entries = Object.entries(values).filter(
    (entry): entry is [string, string | number | true] =>
      entry[1] !== undefined && entry[1] !== '' && entry[1] !== false,
  );
  return new URLSearchParams(entries.map(([key, value]) => [key, String(value)])).toString();
}

async function requestArtifactPage(path: string, signal?: AbortSignal): Promise<ArtifactPage> {
  const page = await request<ArtifactPage>(path, { signal });
  if (!Array.isArray(page.items)) throw invalidResponseError();
  return page;
}

function runArtifactPage(
  projectId: string,
  runId: string,
  query: RunArtifactPageQuery,
  signal?: AbortSignal,
): Promise<ArtifactPage> {
  const { directFilesOnly, ...rest } = query;
  return requestArtifactPage(
    `${runPath(projectId, runId)}/artifacts?${searchParams({
      ...rest,
      delimiter: directFilesOnly ? '/' : undefined,
    })}`,
    signal,
  );
}

function projectArtifactPage(
  projectId: string,
  query: ProjectArtifactPageQuery,
  signal?: AbortSignal,
): Promise<ArtifactPage> {
  return requestArtifactPage(
    `${projectPath(projectId)}/artifacts?${searchParams({ ...query })}`,
    signal,
  );
}
export interface RunSearchCsv {
  blob: Blob;
  fileName: string;
  /** More Runs matched than the export limit; the file ends with a notice line. */
  truncated: boolean;
}

// Used when Content-Disposition is missing or unreadable.
const FALLBACK_EXPORT_FILE_NAME = 'runs.csv';

function attachmentFileName(disposition: string | null): string {
  const encoded = disposition?.match(/filename\*=UTF-8''([^;]+)/)?.[1];
  if (encoded) {
    try {
      return decodeURIComponent(encoded);
    } catch {
      // A malformed escape falls through to the ASCII name.
    }
  }
  return disposition?.match(/filename="([^"]+)"/)?.[1] ?? FALLBACK_EXPORT_FILE_NAME;
}

/** The search CSV is a POST, so it is read as a blob instead of followed as a link. */
async function exportRunSearchCsv(
  projectId: string,
  search: RunSearchRequest,
  signal?: AbortSignal,
): Promise<RunSearchCsv> {
  let response: Response;
  try {
    response = await fetch(`/api${projectPath(projectId)}/runs/search/export.csv`, {
      ...jsonRequest('POST', search),
      credentials: 'include',
      signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new RequestError({ status: 0, code: NETWORK_ERROR_CODE });
  }
  // Same error shape as request() in http.ts, which only reads JSON bodies.
  if (!response.ok) {
    const apiError = (await response.json().catch(() => null)) as {
      error?: unknown;
      code?: unknown;
    } | null;
    throw new RequestError({
      status: response.status,
      code: typeof apiError?.code === 'string' ? apiError.code : undefined,
      serverMessage: typeof apiError?.error === 'string' ? apiError.error : undefined,
    });
  }
  return {
    blob: await response.blob(),
    fileName: attachmentFileName(response.headers.get('Content-Disposition')),
    truncated: response.headers.get(RUN_EXPORT_TRUNCATED_HEADER) === 'true',
  };
}

export const trackingApi = {
  experiments: (projectId: string, signal?: AbortSignal) =>
    requestItems<Experiment>(`${projectPath(projectId)}/experiments`, signal),
  createExperiment: (projectId: string, body: { name: string; description?: string }) =>
    request<Experiment>(`${projectPath(projectId)}/experiments`, jsonRequest('POST', body)),
  searchRuns: async (projectId: string, body: RunSearchRequest, signal?: AbortSignal) => {
    const page = await request<RunSearchPage>(`${projectPath(projectId)}/runs/search`, {
      ...jsonRequest('POST', body),
      signal,
    });
    if (!Array.isArray(page.items)) throw invalidResponseError();
    return page;
  },
  exportRunSearchCsv,
  compareRuns: async (projectId: string, body: RunComparisonRequest, signal?: AbortSignal) => {
    const comparison = await request<RunComparison>(`${projectPath(projectId)}/runs/compare`, {
      ...jsonRequest('POST', body),
      signal,
    });
    if (!Array.isArray(comparison.runs) || !Array.isArray(comparison.rows))
      throw invalidResponseError();
    return comparison;
  },
  /** A GET link the browser downloads with the session cookie. */
  runComparisonCsvUrl: (
    projectId: string,
    comparison: { runIds: string[]; baselineRunId: string | null },
  ) =>
    `/api${projectPath(projectId)}/runs/compare.csv?${searchParams({
      runIds: comparison.runIds.join(','),
      baselineRunId: comparison.baselineRunId ?? undefined,
    })}`,
  run: (projectId: string, runId: string, signal?: AbortSignal) =>
    request<Run>(runPath(projectId, runId), { signal }),
  createRun: (projectId: string, body: CreateRun) =>
    request<Run>(`${projectPath(projectId)}/runs`, jsonRequest('POST', body)),
  updateRun: (projectId: string, runId: string, body: UpdateRun) =>
    request<Run>(runPath(projectId, runId), jsonRequest('PATCH', body)),
  metrics: (projectId: string, runId: string, signal?: AbortSignal) =>
    requestItems<MetricPoint>(`${runPath(projectId, runId)}/metrics`, signal),
  logs: (projectId: string, runId: string, signal?: AbortSignal) =>
    requestItems<LogEntry>(`${runPath(projectId, runId)}/logs`, signal),
  /** Every latest Artifact of a Run, following all pages. Browsers page with runArtifactPage. */
  artifacts: async (projectId: string, runId: string, signal?: AbortSignal) => {
    const items: Artifact[] = [];
    let cursor: string | undefined;
    do {
      const page = await runArtifactPage(projectId, runId, { cursor }, signal);
      items.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor);
    return items;
  },
  runArtifactPage,
  runArtifactTree: async (
    projectId: string,
    runId: string,
    prefix: string,
    signal?: AbortSignal,
  ) => {
    const tree = await request<ArtifactTree>(
      `${runPath(projectId, runId)}/artifacts/tree?${searchParams({ prefix })}`,
      { signal },
    );
    if (!Array.isArray(tree.directories)) throw invalidResponseError();
    return tree;
  },
  projectArtifacts: async (
    projectId: string,
    query: { limit: number; query?: string },
    signal?: AbortSignal,
  ) => (await projectArtifactPage(projectId, query, signal)).items,
  projectArtifactPage,
  artifactUrl: (projectId: string, artifactId: string) =>
    `/api${artifactContentPath(projectId, artifactId)}`,
  artifactText: async (projectId: string, artifactId: string, signal?: AbortSignal) => {
    const response = await fetch(`/api${artifactContentPath(projectId, artifactId)}`, {
      credentials: 'include',
      signal,
    });
    if (!response.ok)
      throw new RequestError({ status: response.status, code: ARTIFACT_CONTENT_UNAVAILABLE_CODE });
    return response.text();
  },
  artifact: (projectId: string, artifactId: string, signal?: AbortSignal) =>
    request<Artifact>(`${projectPath(projectId)}/artifacts/${encodeId(artifactId)}`, { signal }),
  lineage: (projectId: string, signal?: AbortSignal) =>
    request<LineageGraph>(`${projectPath(projectId)}/lineage`, { signal }),
};
