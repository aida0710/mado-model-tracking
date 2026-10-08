import type { MetricXRange, RunGroupBy } from '@mmt/contracts';
import { rows, type Connection } from '../db/database.js';
import type { MetricXAxis } from '../domain/metricSeries/metricSeriesValidation.js';
import type { RunGroupValue } from '../domain/metricSeries/runGrouping.js';
import type {
  BucketPlan,
  SeriesBucketRow,
  SeriesExtent,
} from '../domain/metricSeries/seriesBuckets.js';

// A chart request is interactive; a slower aggregation means the request is too large to serve.
const SERIES_QUERY_TIMEOUT_MS = 10000;
// MLflow stores NaN and infinities; PostgreSQL treats NaN as equal to itself, so NOT IN matches it.
const finiteValue = (column: string) =>
  `${column} NOT IN ('NaN'::float8,'Infinity'::float8,'-Infinity'::float8)`;
// The same merge as the run search compiler: SDK-recorded parameters win over execution parameters.
const RUN_PARAMETERS_SQL = '(r.parameters||r.recorded_parameters)';

/** Which stored points to read, before any bucketing. */
export interface MetricPointSelection {
  runIds: string[];
  keys: string[];
  xAxis: MetricXAxis;
  xRange: MetricXRange | null;
}
export interface RunSeriesExtent extends SeriesExtent {
  runId: string;
  name: string;
  droppedPoints: number;
}
export interface RunSeriesBucketRow extends SeriesBucketRow {
  runId: string;
  name: string;
}
export interface GroupBucketRow {
  groupIndex: number;
  name: string;
  x: number;
  mean: number;
  minValue: number;
  maxValue: number;
  stddev: number;
  runCount: number;
}
type BucketsPlan = Extract<BucketPlan, { kind: 'buckets' }>;

class SqlParameters {
  readonly values: unknown[] = [];
  bind(value: unknown): string {
    return `$${this.values.push(value)}`;
  }
}

function xExpression(xAxis: MetricXAxis): string {
  switch (xAxis.kind) {
    case 'step':
      return 'm.step::float8';
    // date_part returns float8 directly; EXTRACT returns numeric, measured 1.4-1.8 times slower.
    case 'wall_time':
      return "date_part('epoch',m.timestamp)*1000";
    case 'relative_time':
      return "date_part('epoch',m.timestamp-ro.origin)";
    case 'metric':
      // A NaN x cannot be placed on the axis, so it counts as missing.
      return `CASE WHEN ${finiteValue('xv.value')} THEN xv.value END`;
  }
}

/** `WITH ... points AS (id, run_id, name, step, value, x)`; x is NULL when the point has none. */
function pointsCte(selection: MetricPointSelection, parameters: SqlParameters): string {
  const runIds = parameters.bind(selection.runIds);
  const keys = parameters.bind(selection.keys);
  const ctes: string[] = [];
  let join = '';
  if (selection.xAxis.kind === 'relative_time') {
    // COALESCE evaluates the subquery only for Runs that never started. Inlined, the planner ran
    // that subquery once per metric point (minutes for 100k points), so each origin is computed once.
    ctes.push(`run_origins AS MATERIALIZED (SELECT r.id AS run_id,
      COALESCE(r.started_at,(SELECT min(o.timestamp) FROM metrics o WHERE o.run_id=r.id)) AS origin
      FROM runs r WHERE r.id=ANY(${runIds}::uuid[]))`);
    join = 'JOIN run_origins ro ON ro.run_id=m.run_id';
  }
  if (selection.xAxis.kind === 'metric') {
    // Materialized for the same reason: one x per Run and step, read once.
    ctes.push(`x_values AS MATERIALIZED (SELECT DISTINCT ON(run_id,step) run_id,step,value FROM metrics
      WHERE run_id=ANY(${runIds}::uuid[]) AND name=${parameters.bind(selection.xAxis.metricKey)}
      ORDER BY run_id,step,timestamp DESC,id DESC)`);
    join = 'LEFT JOIN x_values xv ON xv.run_id=m.run_id AND xv.step=m.step';
  }
  const range = selection.xRange
    ? `WHERE p.x IS NULL OR p.x BETWEEN ${parameters.bind(selection.xRange.min)} AND ${parameters.bind(selection.xRange.max)}`
    : '';
  ctes.push(`points AS (SELECT * FROM (
    SELECT m.id,m.run_id,m.name,m.step,m.value,${xExpression(selection.xAxis)} AS x
    FROM metrics m ${join} WHERE m.run_id=ANY(${runIds}::uuid[]) AND m.name=ANY(${keys}::text[])
  ) p ${range})`);
  return `WITH ${ctes.join(',')}`;
}

function bucketExpression(plan: string): string {
  // width_bucket puts x equal to the upper bound in count+1; it belongs to the last bucket.
  return `LEAST(width_bucket(p.x,${plan}.lower_bound,${plan}.upper_bound,${plan}.bucket_count),${plan}.bucket_count)`;
}

/** Reads every series in one snapshot and gives up after SERIES_QUERY_TIMEOUT_MS per statement. */
export async function beginSeriesSnapshot(connection: Connection): Promise<void> {
  await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  await connection.query(`SET LOCAL statement_timeout=${SERIES_QUERY_TIMEOUT_MS}`);
}

export function isSeriesQueryTimeout(error: unknown): boolean {
  // query_canceled, raised when statement_timeout expires.
  return (error as { code?: string }).code === '57014';
}

export async function findProjectRunIds(
  connection: Connection,
  runs: { projectId: string; runIds: string[] },
): Promise<string[]> {
  const found = await rows<{ id: string }>(
    connection,
    'SELECT id FROM runs WHERE project_id=$1 AND id=ANY($2::uuid[])',
    [runs.projectId, runs.runIds],
  );
  return found.map((run) => run.id);
}

/** Only Runs of the Project are returned, so a missing row means another Project or no Run. */
export async function readRunGroupValues(
  connection: Connection,
  runs: { projectId: string; runIds: string[]; groupBy: RunGroupBy },
): Promise<RunGroupValue[]> {
  const { groupBy } = runs;
  const parameters = [runs.projectId, runs.runIds];
  if (groupBy.kind === 'experiment')
    return rows<RunGroupValue>(
      connection,
      `SELECT r.id AS run_id,r.experiment_id::text AS value,e.name AS label
      FROM runs r JOIN experiments e ON e.id=r.experiment_id
      WHERE r.project_id=$1 AND r.id=ANY($2::uuid[])`,
      parameters,
    );
  const values = groupBy.kind === 'param' ? RUN_PARAMETERS_SQL : 'r.tags';
  return rows<RunGroupValue>(
    connection,
    `SELECT r.id AS run_id,${values}->>$3::text AS value FROM runs r
    WHERE r.project_id=$1 AND r.id=ANY($2::uuid[])`,
    [...parameters, groupBy.key],
  );
}

export async function readSeriesExtents(
  connection: Connection,
  selection: MetricPointSelection,
): Promise<RunSeriesExtent[]> {
  const parameters = new SqlParameters();
  return rows<RunSeriesExtent>(
    connection,
    `${pointsCte(selection, parameters)}
    SELECT run_id,name,min(x) AS x_min,max(x) AS x_max,count(x)::int AS total_points,
      (count(*)-count(x))::int AS dropped_points
    FROM points GROUP BY run_id,name`,
    parameters.values,
  );
}

/** Groups by point ID for raw plans, so their rows are the stored points. */
export async function readSeriesBuckets(
  connection: Connection,
  query: {
    selection: MetricPointSelection;
    plans: { runId: string; name: string; plan: BucketPlan }[];
  },
): Promise<RunSeriesBucketRow[]> {
  if (!query.plans.length) return [];
  const parameters = new SqlParameters();
  const points = pointsCte(query.selection, parameters);
  const column = <T>(read: (plan: BucketPlan) => T) => query.plans.map(({ plan }) => read(plan));
  const plans = [
    parameters.bind(query.plans.map((series) => series.runId)),
    parameters.bind(query.plans.map((series) => series.name)),
    parameters.bind(column((plan) => (plan.kind === 'buckets' ? plan.lower : null))),
    parameters.bind(column((plan) => (plan.kind === 'buckets' ? plan.upper : null))),
    parameters.bind(column((plan) => (plan.kind === 'buckets' ? plan.count : 0))),
  ];
  const finite = finiteValue('p.value');
  return rows<RunSeriesBucketRow>(
    connection,
    `${points},plans AS (SELECT * FROM unnest(${plans[0]}::uuid[],${plans[1]}::text[],${plans[2]}::float8[],${plans[3]}::float8[],${plans[4]}::int[])
      AS plan(run_id,name,lower_bound,upper_bound,bucket_count))
    SELECT p.run_id,p.name,
      avg(p.x) FILTER (WHERE ${finite}) AS x,
      max(p.step) FILTER (WHERE ${finite})::float8 AS step,
      avg(p.value) FILTER (WHERE ${finite}) AS value,
      min(p.value) FILTER (WHERE ${finite}) AS min_value,
      max(p.value) FILTER (WHERE ${finite}) AS max_value,
      count(*) FILTER (WHERE ${finite})::int AS count,
      count(*) FILTER (WHERE NOT ${finite})::int AS nan_count
    FROM points p JOIN plans pl ON pl.run_id=p.run_id AND pl.name=p.name
    WHERE p.x IS NOT NULL
    GROUP BY p.run_id,p.name,CASE WHEN pl.bucket_count=0 THEN p.id ELSE ${bucketExpression('pl')} END
    ORDER BY p.run_id,p.name,x,step`,
    parameters.values,
  );
}

/** The x extent of each key over every selected Run, for bucket bounds shared by groups. */
export async function readKeyExtents(
  connection: Connection,
  selection: MetricPointSelection,
): Promise<(SeriesExtent & { name: string })[]> {
  const parameters = new SqlParameters();
  return rows<SeriesExtent & { name: string }>(
    connection,
    `${pointsCte(selection, parameters)}
    SELECT name,min(x) AS x_min,max(x) AS x_max,count(x)::int AS total_points
    FROM points GROUP BY name`,
    parameters.values,
  );
}

/**
 * Averages each Run within a bucket first, then takes statistics across those Run means, so a Run
 * that logged more often does not outweigh the others. Runs without a finite value in a bucket
 * are not counted there.
 */
export async function readGroupBuckets(
  connection: Connection,
  query: {
    selection: MetricPointSelection;
    plans: { name: string; plan: BucketsPlan }[];
    memberships: { runId: string; groupIndex: number }[];
  },
): Promise<GroupBucketRow[]> {
  if (!query.plans.length || !query.memberships.length) return [];
  const parameters = new SqlParameters();
  const points = pointsCte(query.selection, parameters);
  const plans = [
    parameters.bind(query.plans.map((series) => series.name)),
    parameters.bind(query.plans.map((series) => series.plan.lower)),
    parameters.bind(query.plans.map((series) => series.plan.upper)),
    parameters.bind(query.plans.map((series) => series.plan.count)),
  ];
  const memberships = [
    parameters.bind(query.memberships.map((membership) => membership.runId)),
    parameters.bind(query.memberships.map((membership) => membership.groupIndex)),
  ];
  return rows<GroupBucketRow>(
    connection,
    `${points},plans AS (SELECT * FROM unnest(${plans[0]}::text[],${plans[1]}::float8[],${plans[2]}::float8[],${plans[3]}::int[])
      AS plan(name,lower_bound,upper_bound,bucket_count)),
    memberships AS (SELECT * FROM unnest(${memberships[0]}::uuid[],${memberships[1]}::int[])
      AS membership(run_id,group_index)),
    run_buckets AS (
      SELECT p.run_id,p.name,${bucketExpression('pl')} AS bucket,avg(p.x) AS x,avg(p.value) AS value
      FROM points p JOIN plans pl ON pl.name=p.name
      WHERE p.x IS NOT NULL AND ${finiteValue('p.value')}
      GROUP BY p.run_id,p.name,bucket)
    SELECT ms.group_index,rb.name,avg(rb.x) AS x,avg(rb.value) AS mean,
      min(rb.value) AS min_value,max(rb.value) AS max_value,stddev_pop(rb.value) AS stddev,
      count(*)::int AS run_count
    FROM run_buckets rb JOIN memberships ms ON ms.run_id=rb.run_id
    GROUP BY ms.group_index,rb.name,rb.bucket
    ORDER BY ms.group_index,rb.name,x`,
    parameters.values,
  );
}
