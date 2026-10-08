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
  RunSearchPage,
  RunSearchRequest,
} from '@mmt/contracts';
import type { CreateRun, UpdateRun } from './inputs';
import {
  ARTIFACT_CONTENT_UNAVAILABLE_CODE,
  ARTIFACT_TOO_LARGE_CODE,
  encodeId,
  invalidResponseError,
  jsonRequest,
  projectPath,
  request,
  RequestError,
  requestItems,
} from './http';

const HTTP_PAYLOAD_TOO_LARGE = 413;

// A front proxy can reject before the API and reply with HTML, so the status decides the code.
async function withArtifactSizeMessage<T>(upload: Promise<T>): Promise<T> {
  try {
    return await upload;
  } catch (error) {
    if (error instanceof RequestError && error.status === HTTP_PAYLOAD_TOO_LARGE)
      throw new RequestError({ status: error.status, code: ARTIFACT_TOO_LARGE_CODE });
    throw error;
  }
}

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
  uploadArtifact: (projectId: string, runId: string | null, path: string, file: File) =>
    withArtifactSizeMessage(
      request<Artifact>(
        `${runId ? runPath(projectId, runId) : projectPath(projectId)}/artifacts?${new URLSearchParams({ path })}`,
        {
          method: 'PUT',
          body: file,
          // The API infers the type from the path when the browser leaves File.type empty.
          headers: { 'Content-Type': file.type || 'application/octet-stream' },
        },
      ),
    ),
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
