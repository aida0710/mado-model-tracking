import type { Connection } from '../db/database.js';

/** One table's part of a purge: which of its rows belong to the purged Project ($1). */
export interface ProjectPurgeStep {
  table: string;
  rowsOfProject: string;
}

const BY_PROJECT_ID = 'project_id=$1';

function byParent(column: string, parentTable: string): string {
  return `${column} IN (SELECT id FROM ${parentTable} WHERE project_id=$1)`;
}

/**
 * Every table that holds rows of a Project, in deletion order. Tables without a project_id column
 * find their rows through the parent, so they come before it; the others may go in any order
 * because the purge defers foreign key checks to its commit (migration 055). Children are still
 * listed before their parents so that no ON DELETE action has to touch them.
 * project-purge.integration.test.ts fails when a table that references a purged one is missing.
 */
export const PROJECT_PURGE_STEPS: readonly ProjectPurgeStep[] = [
  { table: 'metrics', rowsOfProject: byParent('run_id', 'runs') },
  { table: 'run_logs', rowsOfProject: byParent('run_id', 'runs') },
  { table: 'model_aliases', rowsOfProject: byParent('model_id', 'models') },
  { table: 'gpu_reservations', rowsOfProject: byParent('job_id', 'jobs') },
  { table: 'plugin_outbox', rowsOfProject: byParent('plugin_id', 'plugin_connections') },
  { table: 'report_block_snapshots', rowsOfProject: byParent('report_id', 'reports') },
  { table: 'report_revisions', rowsOfProject: byParent('report_id', 'reports') },
  // artifact_upload_parts goes with artifact_uploads (ON DELETE CASCADE).
  ...[
    'comments',
    'saved_views',
    'reports',
    'notification_outbox',
    'notification_rules',
    'notification_channels',
    'operations_alerts',
    'workers',
    'compute_target_projects',
    'project_group_bindings',
    'project_members',
    'demo_seed_history',
    'plugin_connections',
    'run_media',
    'artifact_media_info',
    'artifact_previews',
    'mlflow_artifact_paths',
    'artifact_deletions',
    'artifact_uploads',
    'mlflow_logged_model_metrics',
    'mlflow_model_version_metadata',
    'mlflow_registered_model_metadata',
    'mlflow_run_dataset_inputs',
    'mlflow_run_model_inputs',
    'mlflow_run_model_outputs',
    'mlflow_datasets',
    'mlflow_logged_models',
    'model_promotion_evaluations',
    'model_alias_events',
    'model_promotion_policies',
    'model_alias_protections',
    'model_automation_events',
    'model_automation_executions',
    'hook_executions',
    'sweep_trials',
    'sweeps',
    'job_tokens',
    'jobs',
    'job_array_groups',
    'hooks',
    'model_automation_rules',
    'run_output_declarations',
    'run_output_registrations',
    'run_resume_events',
    'run_sync_batches',
    'run_checkpoints',
    'dataset_version_files',
    'runs',
    'experiment_tasks',
    'model_versions',
    'models',
    'dataset_versions',
    'datasets',
    'code_versions',
    'codes',
    'artifacts',
    'experiments',
  ].map((table) => ({ table, rowsOfProject: BY_PROJECT_ID })),
];

/**
 * Tables with a project_id that keep the purged Project's rows, and why. Users are never
 * deleted; audit events and the API tokens they name as actors are the record of what happened.
 */
export const PROJECT_PURGE_KEPT_TABLES: Readonly<Record<string, string>> = {
  projects: 'the tombstone row (name only) that the kept rows below point at',
  audit_events: 'audit events are kept forever',
  api_tokens: 'audit events name tokens as actors; the purge revokes them',
  users: 'Service Accounts are users, which are never deleted; the purge disables them',
  service_account_details: 'details of the disabled Service Accounts',
  purged_project_blobs: 'the blobs the garbage collector still has to remove',
};

/**
 * Queues the blobs of the Project's Artifacts and upload sessions for the garbage collector,
 * except those it already removed. A session's key may hold a blob its finalizer wrote before the
 * Artifact was registered; removing a key with no blob succeeds.
 */
async function queueProjectBlobs(connection: Connection, projectId: string): Promise<number> {
  const queued = await connection.query(
    `INSERT INTO purged_project_blobs(backend,storage_key,project_id)
    SELECT a.backend,a.storage_key,a.project_id FROM artifacts a
    WHERE a.project_id=$1 AND NOT EXISTS(
      SELECT 1 FROM artifact_deletions d WHERE d.artifact_id=a.id AND d.blob_removed_at IS NOT NULL)
    UNION
    SELECT u.backend,u.storage_key,u.project_id FROM artifact_uploads u WHERE u.project_id=$1
    ON CONFLICT DO NOTHING`,
    [projectId],
  );
  return queued.rowCount ?? 0;
}

// Kept rows stop working: tokens are revoked and Service Accounts disabled.
async function retireKeptIdentities(connection: Connection, projectId: string): Promise<void> {
  await connection.query(
    'UPDATE api_tokens SET revoked_at=now() WHERE project_id=$1 AND revoked_at IS NULL',
    [projectId],
  );
  await connection.query(
    "UPDATE users SET status='disabled' WHERE kind='service' AND service_project_id=$1",
    [projectId],
  );
  await connection.query(
    'UPDATE service_account_details SET disabled_at=COALESCE(disabled_at,now()) WHERE project_id=$1',
    [projectId],
  );
}

/**
 * Deletes every row of a Project whose projects row this transaction has already marked purged
 * (the history triggers of migration 055 check that). Returns what it queued and deleted.
 */
export async function purgeProjectRows(
  connection: Connection,
  projectId: string,
): Promise<{ queuedBlobs: number; deletedRows: number }> {
  await connection.query('SET CONSTRAINTS ALL DEFERRED');
  const queuedBlobs = await queueProjectBlobs(connection, projectId);
  await retireKeptIdentities(connection, projectId);
  let deletedRows = 0;
  for (const step of PROJECT_PURGE_STEPS) {
    // Table names and conditions are constants of this module, never request input.
    const deleted = await connection.query(
      `DELETE FROM ${step.table} WHERE ${step.rowsOfProject}`,
      [projectId],
    );
    deletedRows += deleted.rowCount ?? 0;
  }
  return { queuedBlobs, deletedRows };
}
