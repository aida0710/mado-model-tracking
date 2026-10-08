import {
  DEFAULT_BASELINE_ALIAS,
  type EvaluationComparison,
  type EvaluationComparisonStatus,
} from '@mmt/contracts';
import type { Principal } from '../auth/principal.js';
import { first, type Connection, type Database } from '../db/database.js';
import { DomainError, notFound } from '../domain/errors.js';
import { compareMetrics } from '../domain/evaluationComparison.js';
import { referenceDatasetVersionIds } from '../domain/evaluationInputs.js';
import {
  findLatestEvaluationRun,
  loadEvaluationMetrics,
  type EvaluationRunRecord,
} from '../repositories/evaluationRunRepository.js';
import { assertProjectReferences, assertProjectReference } from '../repositories/registryRepository.js';
import { requireProject } from './accessService.js';

export interface EvaluationComparisonRequest {
  modelId: string;
  candidateVersionId: string;
  baselineAlias?: string;
  baselineVersionId?: string;
  // Omitted conditions are taken from the candidate's latest matching evaluation Run.
  referenceDatasetVersionIds?: readonly string[];
  codeVersionId?: string | null;
  evaluationRuleId?: string;
  metrics?: readonly string[];
}

export class EvaluationService {
  constructor(private readonly database: Database) {}

  async compareToBaseline(
    principal: Principal,
    projectId: string,
    request: EvaluationComparisonRequest,
  ): Promise<EvaluationComparison> {
    await requireProject(this.database, principal, { projectId, role: 'viewer', scope: 'read' });
    return compareToBaselineInternal(this.database, projectId, request);
  }
}

async function assertModelVersion(
  connection: Connection,
  version: { projectId: string; modelId: string; id: string },
): Promise<void> {
  const found = await first(
    connection,
    'SELECT id FROM model_versions WHERE id=$1 AND model_id=$2 AND project_id=$3',
    [version.id, version.modelId, version.projectId],
  );
  if (!found) notFound('ModelVersion');
}

async function assertAutomationRule(
  connection: Connection,
  rule: { projectId: string; id: string },
): Promise<void> {
  const found = await first(
    connection,
    'SELECT id FROM model_automation_rules WHERE id=$1 AND project_id=$2',
    [rule.id, rule.projectId],
  );
  if (!found) notFound('ModelAutomationRule');
}

async function validateReferences(
  connection: Connection,
  projectId: string,
  request: EvaluationComparisonRequest,
): Promise<void> {
  if (request.baselineAlias !== undefined && request.baselineVersionId !== undefined)
    throw new DomainError(
      422,
      '基準はbaselineAliasとbaselineVersionIdのどちらか一方で指定してください',
      'invalid_request',
    );
  await assertProjectReference(connection, { table: 'models', projectId, id: request.modelId });
  await assertModelVersion(connection, {
    projectId,
    modelId: request.modelId,
    id: request.candidateVersionId,
  });
  if (request.baselineVersionId)
    await assertModelVersion(connection, {
      projectId,
      modelId: request.modelId,
      id: request.baselineVersionId,
    });
  if (request.referenceDatasetVersionIds)
    await assertProjectReferences(connection, {
      table: 'dataset_versions',
      projectId,
      ids: [...request.referenceDatasetVersionIds],
    });
  if (request.codeVersionId)
    await assertProjectReference(connection, {
      table: 'code_versions',
      projectId,
      id: request.codeVersionId,
    });
  if (request.evaluationRuleId)
    await assertAutomationRule(connection, { projectId, id: request.evaluationRuleId });
}

async function resolveBaselineVersionId(
  connection: Connection,
  request: { modelId: string; baselineAlias: string | null; baselineVersionId?: string },
): Promise<string | null> {
  if (request.baselineVersionId) return request.baselineVersionId;
  const alias = await first<{ versionId: string }>(
    connection,
    'SELECT version_id FROM model_aliases WHERE model_id=$1 AND alias=$2',
    [request.modelId, request.baselineAlias],
  );
  return alias?.versionId ?? null;
}

function comparisonStatus(runs: {
  baselineVersionId: string | null;
  candidateRun: EvaluationRunRecord | undefined;
  baselineRun: EvaluationRunRecord | undefined;
}): EvaluationComparisonStatus {
  if (!runs.baselineVersionId) return 'baseline_missing';
  if (!runs.candidateRun) return 'candidate_not_evaluated';
  if (!runs.baselineRun) return 'baseline_not_evaluated';
  return 'ok';
}

/**
 * Compares the candidate version's latest evaluation with the baseline version's latest evaluation
 * under the same conditions. Missing baselines or evaluations are reported in status, not as errors,
 * so automated callers can decide (for example, promotion treats a missing baseline as a first
 * release). Callers must authorize first: promotion-policy-gate calls this inside the evaluation
 * Run's terminal transaction without a principal.
 */
export async function compareToBaselineInternal(
  connection: Connection,
  projectId: string,
  request: EvaluationComparisonRequest,
): Promise<EvaluationComparison> {
  await validateReferences(connection, projectId, request);
  const baselineAlias =
    request.baselineVersionId === undefined
      ? (request.baselineAlias ?? DEFAULT_BASELINE_ALIAS)
      : null;
  const baselineVersionId = await resolveBaselineVersionId(connection, {
    modelId: request.modelId,
    baselineAlias,
    baselineVersionId: request.baselineVersionId,
  });
  const evaluationRuleId = request.evaluationRuleId ?? null;
  const candidateRun = await findLatestEvaluationRun(connection, {
    projectId,
    modelVersionId: request.candidateVersionId,
    referenceDatasetVersionIds: request.referenceDatasetVersionIds,
    codeVersionId: request.codeVersionId,
    producedByRuleId: evaluationRuleId,
  });
  const references = request.referenceDatasetVersionIds
    ? [...new Set(request.referenceDatasetVersionIds)].sort()
    : candidateRun
      ? referenceDatasetVersionIds(candidateRun)
      : null;
  const codeVersionId =
    request.codeVersionId !== undefined ? request.codeVersionId : candidateRun?.codeVersionId;
  // Without a candidate evaluation the conditions are only known when the caller gave all of them.
  const conditionsDecided = references !== null && codeVersionId !== undefined;
  const baselineRun =
    baselineVersionId && conditionsDecided
      ? await findLatestEvaluationRun(connection, {
          projectId,
          modelVersionId: baselineVersionId,
          referenceDatasetVersionIds: references,
          codeVersionId,
          producedByRuleId: evaluationRuleId,
        })
      : undefined;
  const loadMetrics = (run: EvaluationRunRecord | undefined) =>
    run
      ? loadEvaluationMetrics(connection, {
          projectId,
          run,
          referenceDatasetVersionIds: references ?? [],
        })
      : null;
  return {
    status: comparisonStatus({ baselineVersionId, candidateRun, baselineRun }),
    modelId: request.modelId,
    candidateVersionId: request.candidateVersionId,
    baselineAlias,
    baselineVersionId,
    candidateRunId: candidateRun?.id ?? null,
    baselineRunId: baselineRun?.id ?? null,
    referenceDatasetVersionIds: references ?? [],
    codeVersionId: codeVersionId ?? null,
    evaluationRuleId,
    metrics: compareMetrics({
      candidate: await loadMetrics(candidateRun),
      baseline: await loadMetrics(baselineRun),
      metricKeys: request.metrics,
    }),
  };
}
