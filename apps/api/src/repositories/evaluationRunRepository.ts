import type { Run } from '@mmt/contracts';
import { first, rows, type Connection } from '../db/database.js';
import type { EvaluatedMetrics } from '../domain/evaluationComparison.js';

export type EvaluationRunRecord = Pick<
  Run,
  | 'id'
  | 'codeVersionId'
  | 'inputDatasetVersionIds'
  | 'upstreamDatasetVersionIds'
  | 'latestMetrics'
  | 'endedAt'
>;

// The reference set (see domain/evaluationInputs.ts) computed in SQL so it can be matched in the WHERE.
const referenceSetExpression = `ARRAY(
  SELECT unnest(r.input_dataset_version_ids) EXCEPT SELECT unnest(r.upstream_dataset_version_ids))`;

/**
 * The latest comparable evaluation of a model version: same Project, kind=evaluation, finished,
 * active, and — when given — the same reference set (as a set), the same evaluation CodeVersion
 * (null matches Runs without code), and created by the given automation rule. The rule filter lets
 * promotion policies ignore manually created evaluation Runs. Newest ended_at wins; id breaks ties.
 */
export async function findLatestEvaluationRun(
  connection: Connection,
  filter: {
    projectId: string;
    modelVersionId: string;
    referenceDatasetVersionIds?: readonly string[];
    codeVersionId?: string | null;
    producedByRuleId?: string | null;
  },
): Promise<EvaluationRunRecord | undefined> {
  return first<EvaluationRunRecord>(
    connection,
    `SELECT r.id,r.code_version_id,r.input_dataset_version_ids,r.upstream_dataset_version_ids,
      r.latest_metrics,r.ended_at
    FROM runs r
    WHERE r.project_id=$1 AND r.model_version_id=$2
      AND r.kind='evaluation' AND r.status='finished' AND r.lifecycle_stage='active'
      AND ($3::uuid[] IS NULL OR (${referenceSetExpression} @> $3::uuid[] AND ${referenceSetExpression} <@ $3::uuid[]))
      AND (NOT $4::boolean OR r.code_version_id IS NOT DISTINCT FROM $5::uuid)
      AND ($6::uuid IS NULL OR EXISTS (
        SELECT 1 FROM model_automation_executions e
        WHERE e.project_id=r.project_id AND e.run_id=r.id AND e.rule_id=$6::uuid))
    ORDER BY r.ended_at DESC NULLS LAST, r.id DESC
    LIMIT 1`,
    [
      filter.projectId,
      filter.modelVersionId,
      filter.referenceDatasetVersionIds ? [...filter.referenceDatasetVersionIds] : null,
      filter.codeVersionId !== undefined,
      filter.codeVersionId ?? null,
      filter.producedByRuleId ?? null,
    ],
  );
}

// PostgreSQL turns non-finite doubles into JSON strings when building latest_metrics.
function parseLatestMetricValue(value: unknown): number | undefined {
  if (typeof value === 'number') return value;
  if (value === 'NaN' || value === 'Infinity' || value === '-Infinity') return Number(value);
  return undefined;
}

/**
 * Prefers, per metric key, the latest MLflow point logged with the digest of a reference
 * DatasetVersion (step, then timestamp, as latest_metrics orders them). Keys without such a point
 * fall back to the Run's latest_metrics, which mixes every dataset context.
 */
export async function loadEvaluationMetrics(
  connection: Connection,
  evaluation: {
    projectId: string;
    run: Pick<EvaluationRunRecord, 'id' | 'latestMetrics'>;
    referenceDatasetVersionIds: readonly string[];
  },
): Promise<EvaluatedMetrics> {
  const contextPoints = await rows<{ name: string; value: number }>(
    connection,
    `SELECT DISTINCT ON (m.name) m.name,m.value
    FROM metrics m
    WHERE m.run_id=$1 AND m.mlflow_dataset_digest IN (
      SELECT d.digest FROM dataset_versions d WHERE d.project_id=$2 AND d.id=ANY($3::uuid[]))
    ORDER BY m.name,m.step DESC,m.timestamp DESC,m.value DESC,m.id DESC`,
    [evaluation.run.id, evaluation.projectId, [...evaluation.referenceDatasetVersionIds]],
  );
  const metrics: Record<string, { value: number; source: 'dataset_context' | 'run_latest' }> = {};
  for (const [key, raw] of Object.entries(evaluation.run.latestMetrics)) {
    const value = parseLatestMetricValue(raw);
    if (value !== undefined) metrics[key] = { value, source: 'run_latest' };
  }
  for (const point of contextPoints)
    metrics[point.name] = { value: Number(point.value), source: 'dataset_context' };
  return metrics;
}
