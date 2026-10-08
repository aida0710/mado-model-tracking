import { randomUUID } from 'node:crypto';
import type { PluginEvent, Run } from '@mmt/contracts';
import type { Connection } from '../db/database.js';
import { findDatasetVersions } from '../repositories/registryRepository.js';

export async function enqueueRunEvent(connection: Connection, run: Run): Promise<void> {
  if (run.status === 'queued') return;
  // Code text and CodeVersion environment belong to the execution API, not external lineage consumers.
  const { executionSnapshot: _executionSnapshot, ...eventRun } = run;
  const event: PluginEvent = {
    id: randomUUID(),
    type: run.status === 'running' ? 'run.started' : `run.${run.status}`,
    timestamp: run.endedAt ?? run.startedAt ?? new Date().toISOString(),
    projectId: run.projectId,
    run: eventRun,
    inputDatasets: await findDatasetVersions(connection, {
      projectId: run.projectId,
      ids: run.inputDatasetVersionIds,
    }),
    outputDatasets: await findDatasetVersions(connection, {
      projectId: run.projectId,
      ids: run.outputDatasetVersionIds,
    }),
  };
  // Each connection receives the same immutable event snapshot and id for deduplication.
  await connection.query(
    `INSERT INTO plugin_outbox(plugin_id,event_id,event)
    SELECT id,$2,$3::jsonb FROM plugin_connections WHERE project_id=$1 AND enabled=true`,
    [run.projectId, event.id, JSON.stringify(event)],
  );
}
