import type { JsonValue, RunStatus, SweepObjective } from '@mmt/contracts';
import { first, rows, type Connection } from '../db/database.js';

// The same merge as the run search compiler: SDK-recorded parameters win over execution parameters.
const RUN_PARAMETERS_SQL = '(r.parameters||r.recorded_parameters)';

/** One Run with only what the analysis needs; executionSnapshot and the rest stay in the DB. */
export interface RunAnalysisSource {
  runId: string;
  name: string;
  experimentId: string;
  status: RunStatus;
  sweepTrialIndex: number | null;
  sweepObjectiveValue: number | null;
  parameters: Record<string, JsonValue>;
  /** Raw latest_metrics entries of the requested keys; non-finite values arrive as strings. */
  latestMetrics: Record<string, unknown>;
}

const selectColumns = (parameters: string) => `r.id AS run_id,r.name,r.experiment_id,r.status,
  t.trial_index AS sweep_trial_index,t.objective_value AS sweep_objective_value,
  ${parameters} AS parameters,
  (SELECT COALESCE(jsonb_object_agg(e.key,e.value),'{}') FROM jsonb_each(r.latest_metrics) e
    WHERE e.key=ANY($3::text[])) AS latest_metrics`;

/** Only Runs of the Project are returned, so a missing row means another Project or no Run. */
export async function readRunAnalysisSources(
  connection: Connection,
  runs: { projectId: string; runIds: string[]; metricKeys: string[] },
): Promise<RunAnalysisSource[]> {
  return rows<RunAnalysisSource>(
    connection,
    `SELECT ${selectColumns(RUN_PARAMETERS_SQL)}
    FROM runs r LEFT JOIN sweep_trials t ON t.run_id=r.id
    WHERE r.project_id=$1 AND r.id=ANY($2::uuid[])
    ORDER BY r.created_at DESC,r.id DESC`,
    [runs.projectId, runs.runIds, runs.metricKeys],
  );
}

/**
 * The trials of one sweep whose Run is active, in trial order, at most `limit` of them. The
 * trial's own values win over the Run's, since the Run may record them again as strings.
 */
export async function readSweepAnalysisSources(
  connection: Connection,
  sweep: { projectId: string; sweepId: string; metricKeys: string[]; limit: number },
): Promise<RunAnalysisSource[]> {
  return rows<RunAnalysisSource>(
    connection,
    `SELECT ${selectColumns(`(${RUN_PARAMETERS_SQL}||t.parameters)`)}
    FROM sweep_trials t JOIN runs r ON r.id=t.run_id
    WHERE t.project_id=$1 AND t.sweep_id=$2 AND r.lifecycle_stage='active'
    ORDER BY t.trial_index
    LIMIT $4`,
    [sweep.projectId, sweep.sweepId, sweep.metricKeys, sweep.limit],
  );
}

export async function findSweepObjective(
  connection: Connection,
  sweep: { projectId: string; sweepId: string },
): Promise<SweepObjective | undefined> {
  const found = await first<{ objective: SweepObjective }>(
    connection,
    'SELECT objective FROM sweeps WHERE project_id=$1 AND id=$2',
    [sweep.projectId, sweep.sweepId],
  );
  return found?.objective;
}
