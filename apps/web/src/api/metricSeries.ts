import type {
  MetricGroupsRequest,
  MetricGroupsResponse,
  MetricSeriesRequest,
  MetricSeriesResponse,
  RunResumeEventPage,
} from '@mmt/contracts';
import { encodeId, invalidResponseError, jsonRequest, projectPath, request } from './http';

/** Sampled metric series for charts, and the resume events a chart marks on its x axis. */
export const metricSeriesApi = {
  series: async (projectId: string, body: MetricSeriesRequest, signal?: AbortSignal) => {
    const response = await request<MetricSeriesResponse>(
      `${projectPath(projectId)}/metrics/series`,
      { ...jsonRequest('POST', body), signal },
    );
    if (!Array.isArray(response.series)) throw invalidResponseError();
    return response;
  },
  groups: async (projectId: string, body: MetricGroupsRequest, signal?: AbortSignal) => {
    const response = await request<MetricGroupsResponse>(
      `${projectPath(projectId)}/metrics/groups`,
      { ...jsonRequest('POST', body), signal },
    );
    if (!Array.isArray(response.groups)) throw invalidResponseError();
    return response;
  },
  resumeEvents: async (projectId: string, runId: string, signal?: AbortSignal) => {
    const page = await request<RunResumeEventPage>(
      `${projectPath(projectId)}/runs/${encodeId(runId)}/resume-events`,
      { signal },
    );
    if (!Array.isArray(page.items) || !Array.isArray(page.segments)) throw invalidResponseError();
    return page;
  },
};
