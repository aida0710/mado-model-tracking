// Liveness is judged against the database clock so API hosts with skewed clocks agree.

// Workers send a Job heartbeat every 5 seconds; 12 missed heartbeats mark the Job as stale.
export const JOB_HEARTBEAT_STALE_SECONDS = 60;
// Idle workers claim about once per second, so two minutes of silence means the process is gone.
export const WORKER_OFFLINE_SECONDS = 120;
// Claims arrive every second; refresh presence less often to avoid a row write per claim.
export const WORKER_PRESENCE_WRITE_INTERVAL_SECONDS = 15;

function qualified(alias: string, column: string): string {
  return alias ? `${alias}.${column}` : column;
}

// Site Jobs waiting for submission or in a scheduler queue have no runner yet, so no heartbeat.
const PHASES_WITHOUT_HEARTBEAT = ['waiting_manual', 'submitting', 'submitted'];

// Staleness is only reported. Jobs are not failed, re-queued, or released from their GPUs,
// because a silent worker may still be running the process (docs/worker.md).
export function jobHeartbeatStaleSql(alias = ''): string {
  const waitingPhases = PHASES_WITHOUT_HEARTBEAT.map((phase) => `'${phase}'`).join(',');
  return `(${qualified(alias, 'status')} IN ('claimed','running') AND ${qualified(alias, 'heartbeat_at')} < now() - interval '${JOB_HEARTBEAT_STALE_SECONDS} seconds'
    AND (${qualified(alias, 'phase')} IS NULL OR ${qualified(alias, 'phase')} NOT IN (${waitingPhases})))`;
}

export function workerOfflineSql(alias = ''): string {
  return `(${qualified(alias, 'last_seen_at')} < now() - interval '${WORKER_OFFLINE_SECONDS} seconds')`;
}

export function workerPresenceStatusSql(alias = ''): string {
  return `(CASE WHEN ${workerOfflineSql(alias)} THEN 'offline' ELSE 'online' END)`;
}

export function workerPresenceWriteDueSql(alias = ''): string {
  return `(${qualified(alias, 'last_seen_at')} < now() - interval '${WORKER_PRESENCE_WRITE_INTERVAL_SECONDS} seconds')`;
}
