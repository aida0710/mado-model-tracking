import type { RunMediaKeySummary } from '@mmt/contracts';
import { runMediaApi, type RunMediaOfKey } from '../api/runMedia';
import { useQuery, type QueryState } from './useQuery';

/**
 * The media keys a Run recorded and every item of the selected key in step order. The selected key
 * is the chosen one, or the first key until the user chooses.
 */
export function useRunMedia({
  projectId,
  runId,
  chosenKey,
}: {
  projectId: string;
  runId: string;
  chosenKey: string | null;
}): {
  keys: QueryState<RunMediaKeySummary[]>;
  selectedKey: string | null;
  items: QueryState<RunMediaOfKey>;
} {
  const keys = useQuery(`${projectId}:run-media-keys:${runId}`, (signal) => runMediaApi.keys(projectId, runId, signal));
  const selectedKey = chosenKey ?? keys.value?.[0]?.key ?? null;
  const items = useQuery(selectedKey === null ? null : `${projectId}:run-media:${runId}:${selectedKey}`, (signal) =>
    runMediaApi.list(projectId, runId, { key: selectedKey! }, signal),
  );
  return { keys, selectedKey, items };
}
