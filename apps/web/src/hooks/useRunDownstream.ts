import { registryApi } from '../api/registry';
import { useCursorPages } from './useCursorPages';

/** The Runs a Run started (its children), newest first, with "load more". */
export function useRunDownstream(projectId: string, runId: string) {
  return useCursorPages(`${projectId}:run:${runId}:downstream`, (cursor, signal) =>
    registryApi.runDownstream(projectId, runId, { cursor, signal }),
  );
}
