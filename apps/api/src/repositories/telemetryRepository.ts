import type { LogEntry, MetricPoint } from '@mmt/contracts';
import type { Connection } from '../db/database.js';
import { rows } from '../db/database.js';

export async function appendMetrics(
  connection: Connection,
  runId: string,
  metrics: MetricPoint[],
): Promise<void> {
  await connection.query(
    `INSERT INTO metrics(run_id,name,value,step,timestamp)
    SELECT $1,name,value,step,timestamp FROM jsonb_to_recordset($2::jsonb) AS point(name text,value double precision,step bigint,timestamp timestamptz)`,
    [runId, JSON.stringify(metrics)],
  );
  // Arrival order can differ from step order during reconnects.
  await connection.query(
    `UPDATE runs SET latest_metrics=COALESCE((SELECT jsonb_object_agg(name,value) FROM
    (SELECT DISTINCT ON(name) name,value FROM metrics WHERE run_id=$1 ORDER BY name,step DESC,timestamp DESC,value DESC,id DESC) latest),'{}'::jsonb) WHERE id=$1`,
    [runId],
  );
}

export async function appendLogs(
  connection: Connection,
  runId: string,
  entries: LogEntry[],
): Promise<void> {
  await connection.query(
    `INSERT INTO run_logs(run_id,timestamp,level,message)
    SELECT $1,timestamp,level,message FROM jsonb_to_recordset($2::jsonb) AS entry(timestamp timestamptz,level text,message text)`,
    [runId, JSON.stringify(entries)],
  );
}

export async function listMetrics(connection: Connection, runId: string): Promise<MetricPoint[]> {
  return rows(
    connection,
    'SELECT name,value,step::float8 AS step,timestamp FROM metrics WHERE run_id=$1 ORDER BY step,timestamp,id',
    [runId],
  );
}

export async function listLogs(connection: Connection, runId: string): Promise<LogEntry[]> {
  return rows(
    connection,
    'SELECT timestamp,level,message FROM run_logs WHERE run_id=$1 ORDER BY id',
    [runId],
  );
}
