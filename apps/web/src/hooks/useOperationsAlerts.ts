import { operationsApi } from '../api/operations';
import { useQuery } from './useQuery';

// The API monitor checks every 30 seconds; polling faster would only repeat the same answer.
export const OPERATIONS_ALERT_POLL_MS = 30_000;

/** Open operations alerts of a Project, refreshed while the header is shown. */
export function useOperationsAlerts(projectId: string | undefined) {
  return useQuery(
    projectId ? `operations-alerts:${projectId}` : null,
    (signal) => operationsApi.openAlerts(projectId!, signal),
    OPERATIONS_ALERT_POLL_MS,
  );
}
