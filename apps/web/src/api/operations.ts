import type { OperationsAlert, PluginOutboxSummary } from '@mmt/contracts';
import { encodeId, projectPath, request, requestItems } from './http';

/** Alerts kept by the API's operations monitor, and a plugin's event delivery state. */
export const operationsApi = {
  /** Unresolved alerts of the Project, newest first. Readable by every Project member. */
  openAlerts: (projectId: string, signal?: AbortSignal) =>
    requestItems<OperationsAlert>(`${projectPath(projectId)}/operations-alerts?state=open`, signal),
  /** Project admin only. */
  pluginOutbox: (projectId: string, pluginId: string, signal?: AbortSignal) =>
    request<PluginOutboxSummary>(`${projectPath(projectId)}/plugins/${encodeId(pluginId)}/outbox`, {
      signal,
    }),
};
