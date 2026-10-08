import type {
  AutomatedRunSummary,
  Model,
  ModelVersionDetail,
  ModelVersionEvaluationSummary,
  Run,
  RunDownstreamPage,
} from '@mmt/contracts';
import { MODEL_VERSION_RESULT_RUN_KINDS } from '@mmt/contracts';
import type { Principal } from '../auth/principal.js';
import { first, type Connection, type Database } from '../db/database.js';
import { notFound } from '../domain/errors.js';
import type {
  ModelVersionEvaluationQuery,
  RunDownstreamQuery,
} from '../domain/modelEvaluationValidation.js';
import { findExecutionForRun } from '../repositories/automationExecutionLookup.js';
import { findModelVersion, findRun, modelSelect } from '../repositories/registryRepository.js';
import {
  findRelatedRunBoundary,
  listRelatedRuns,
  type RunRelation,
} from '../repositories/relatedRunRepository.js';
import { requireProject } from './accessService.js';

interface RelatedRunPage {
  items: AutomatedRunSummary[];
  nextCursor: string | null;
}

/**
 * Read model for the model version page: the version with its aliases, the Runs that used it, and
 * the Runs a Run started. Whether a Run came from automation is decided by its execution
 * (findExecutionForRun), never by its tags.
 */
export class ModelEvaluationService {
  constructor(private readonly database: Database) {}

  async versionDetail(
    principal: Principal,
    reference: { projectId: string; versionId: string },
  ): Promise<ModelVersionDetail> {
    await this.requireReader(principal, reference.projectId);
    const version = await findModelVersion(this.database, {
      projectId: reference.projectId,
      id: reference.versionId,
    });
    const model = await first<Model>(
      this.database,
      `${modelSelect} WHERE m.project_id=$1 AND m.id=$2`,
      [reference.projectId, version.modelId],
    );
    if (!model) notFound('Model');
    const aliases = Object.entries(model.aliases)
      .filter(([, versionId]) => versionId === version.id)
      .map(([alias]) => alias)
      .sort();
    return { version, model, aliases };
  }

  async versionEvaluations(
    principal: Principal,
    reference: { projectId: string; versionId: string },
    query: ModelVersionEvaluationQuery,
  ): Promise<ModelVersionEvaluationSummary> {
    await this.requireReader(principal, reference.projectId);
    await findModelVersion(this.database, {
      projectId: reference.projectId,
      id: reference.versionId,
    });
    const page = await this.relatedRuns({
      projectId: reference.projectId,
      relation: { column: 'model_version_id', id: reference.versionId },
      kinds: query.kind ? [query.kind] : MODEL_VERSION_RESULT_RUN_KINDS,
      limit: query.limit,
      cursor: query.cursor,
    });
    return { modelVersionId: reference.versionId, ...page };
  }

  async downstream(
    principal: Principal,
    reference: { projectId: string; runId: string },
    query: RunDownstreamQuery,
  ): Promise<RunDownstreamPage> {
    await this.requireReader(principal, reference.projectId);
    await findRun(this.database, { projectId: reference.projectId, id: reference.runId });
    const page = await this.relatedRuns({
      projectId: reference.projectId,
      relation: { column: 'parent_run_id', id: reference.runId },
      kinds: null,
      limit: query.limit,
      cursor: query.cursor,
    });
    return { runId: reference.runId, ...page };
  }

  private async relatedRuns(request: {
    projectId: string;
    relation: RunRelation;
    kinds: Parameters<typeof listRelatedRuns>[1]['kinds'];
    limit: number;
    cursor: string | undefined;
  }): Promise<RelatedRunPage> {
    const { projectId, relation } = request;
    const after = request.cursor
      ? await findRelatedRunBoundary(this.database, { projectId, relation, runId: request.cursor })
      : undefined;
    if (request.cursor && !after) notFound('Run cursor');
    const runs = await listRelatedRuns(this.database, {
      projectId,
      relation,
      kinds: request.kinds,
      limit: request.limit + 1,
      after,
    });
    const pageRuns = runs.slice(0, request.limit);
    const items: AutomatedRunSummary[] = [];
    for (const run of pageRuns) items.push(await summarizeRun(this.database, run));
    return {
      items,
      nextCursor: runs.length > request.limit ? pageRuns.at(-1)!.id : null,
    };
  }

  private async requireReader(principal: Principal, projectId: string): Promise<void> {
    await requireProject(this.database, principal, { projectId, role: 'viewer', scope: 'read' });
  }
}

async function summarizeRun(connection: Connection, run: Run): Promise<AutomatedRunSummary> {
  const execution = await findExecutionForRun(connection, {
    projectId: run.projectId,
    runId: run.id,
  });
  const upstream = new Set(run.upstreamDatasetVersionIds);
  return {
    id: run.id,
    name: run.name,
    kind: run.kind,
    status: run.status,
    modelVersionId: run.modelVersionId,
    codeVersionId: run.codeVersionId,
    parentRunId: run.parentRunId,
    latestMetrics: run.latestMetrics,
    parameters: run.parameters,
    referenceDatasetVersionIds: run.inputDatasetVersionIds.filter((id) => !upstream.has(id)),
    upstreamDatasetVersionIds: run.upstreamDatasetVersionIds,
    automatic: execution !== null,
    ruleId: execution?.ruleId ?? null,
    executionId: execution?.id ?? null,
    pipelineRootExecutionId: execution?.pipelineRootExecutionId ?? null,
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
  };
}
