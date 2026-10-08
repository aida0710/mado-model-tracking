import type { RunResumeEventPage } from '@mmt/contracts';
import { encodeId, invalidResponseError, projectPath, request } from './http';

/** Resume events of a Run and the running segments they split it into. */
export const runResumeApi = {
  events: async (projectId: string, runId: string, signal?: AbortSignal) => {
    const page = await request<RunResumeEventPage>(
      `${projectPath(projectId)}/runs/${encodeId(runId)}/resume-events`,
      { signal },
    );
    if (!Array.isArray(page.items) || !Array.isArray(page.segments)) throw invalidResponseError();
    return page;
  },
};
