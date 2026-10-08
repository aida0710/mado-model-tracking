import { randomUUID } from 'node:crypto';
import type { Principal } from '../../auth/principal.js';
import { first, rows, transaction, type Connection, type Database } from '../../db/database.js';
import { conflict, notFound } from '../../domain/errors.js';
import { uuidSchema } from '../../domain/validation.js';
import { parse } from '../../http/request.js';
import { findRun } from '../../repositories/registryRepository.js';
import { requireProject } from '../../services/accessService.js';
import { enqueueRunEvent } from '../../services/outboxEvents.js';
import type { RegistryService } from '../../services/registryService.js';
import type { RunService } from '../../services/runService.js';
import { logDatasetInputs } from './datasetInputs.js';
import { findTrackingExperiment, resolveExperimentId } from './experimentService.js';
import { logRunModels } from './runModels.js';
import { appendTrackingMetrics, metricHistory } from './trackingMetrics.js';
import { resolveTrackingLifecycle } from './trackingLifecycle.js';
import { appendParameters, collectValues } from './trackingParameters.js';
import { compileSearch, nextPageToken, pageOffset } from './trackingSearch.js';
import { serializeRun, serializeRunInfo, serializeRuns } from './trackingSerialization.js';
import {
  type KeyValue,
  type MlflowRunStatus,
  type TrackingBatch,
  type TrackingDatasetInput,
  type TrackingRun,
  type TrackingSearch,
} from './trackingTypes.js';
import { invalidParameter } from './trackingValidation.js';

// Keep names readable while the full UUID remains the Run's unique identity.
const RUN_NAME_ID_LENGTH = 8;
// Parent edits have their own namespace so they cannot block dataset registration locks.
const PARENT_RUN_LOCK_NAMESPACE = 4184;

export class RunTrackingService {
  private readonly database: Database;
  private readonly runs: RunService;
  private readonly registry: RegistryService;
  constructor(options: { database: Database; runs: RunService; registry: RegistryService }) {
    this.database = options.database;
    this.runs = options.runs;
    this.registry = options.registry;
  }
  async create(
    principal: Principal,
    projectId: string,
    input: {
      experiment_id: string;
      user_id?: string;
      run_name?: string;
      start_time?: number;
      tags: KeyValue[];
    },
  ) {
    return transaction(this.database, async (connection) => {
      await requireProject(connection, principal, {
        projectId,
        role: 'editor',
        scope: 'runs:write',
      });
      if (input.experiment_id === '0') {
        await connection.query(
          "INSERT INTO experiments(project_id,name) VALUES($1,'Default') ON CONFLICT(project_id,name) DO NOTHING",
          [projectId],
        );
      }
      const experiment = await findTrackingExperiment(connection, {
        projectId,
        id: input.experiment_id,
      });
      const lockedExperiment = await first<{ lifecycleStage: string }>(
        connection,
        'SELECT lifecycle_stage FROM experiments WHERE id=$1 FOR SHARE',
        [experiment.id],
      );
      if (lockedExperiment?.lifecycleStage !== 'active')
        invalidParameter('削除済みExperimentにRunを作成できません');
      const tags = collectValues(input.tags);
      const name =
        input.run_name ||
        tags['mlflow.runName'] ||
        `run-${randomUUID().slice(0, RUN_NAME_ID_LENGTH)}`;
      if (input.run_name && tags['mlflow.runName'] && input.run_name !== tags['mlflow.runName'])
        invalidParameter('run_nameとmlflow.runNameが一致しません');
      tags['mlflow.runName'] = name;
      const parentRunId =
        tags['mlflow.parentRunId'] === undefined
          ? null
          : parse(uuidSchema, tags['mlflow.parentRunId']);
      if (parentRunId)
        await this.validateParent(connection, {
          projectId,
          experimentId: experiment.id,
          parentRunId,
        });
      const run = await this.runs.insertRun(connection, {
        projectId,
        createdBy: principal.user.id,
        input: {
          experimentId: experiment.id,
          name,
          kind: 'training',
          parameters: {},
          tags,
          inputDatasetVersionIds: [],
          parentRunId: parentRunId ?? null,
          environment: {},
        },
      });
      const started = (await first<TrackingRun>(
        connection,
        "UPDATE runs SET status='running',started_at=$2,mlflow_managed=true,mlflow_user_id=$3 WHERE id=$1 RETURNING *",
        [
          run.id,
          new Date(input.start_time ?? Date.now()).toISOString(),
          input.user_id ?? principal.user.id,
        ],
      ))!;
      await enqueueRunEvent(connection, started);
      return serializeRun(connection, started);
    });
  }
  async get(principal: Principal, projectId: string, id: string) {
    return this.read(principal, projectId, async (connection) => {
      const run = (await findRun(connection, { projectId, id })) as TrackingRun;
      return serializeRun(connection, run);
    });
  }
  async search(
    principal: Principal,
    projectId: string,
    input: TrackingSearch & { experiment_ids: string[]; run_view_type: number },
  ) {
    return this.read(principal, projectId, async (connection) => {
      const experimentIds: string[] = [];
      for (const id of [...new Set(input.experiment_ids)]) {
        const experimentId = await resolveExperimentId(connection, projectId, id);
        await findTrackingExperiment(connection, { projectId, id: experimentId });
        experimentIds.push(experimentId);
      }
      const query = {
        entity: 'run',
        projectId,
        experimentIds,
        filter: input.filter,
        order_by: input.order_by,
        view_type: input.run_view_type,
      };
      const offset = pageOffset(input.page_token, query);
      const search = compileSearch('run', input, [projectId, experimentIds, input.run_view_type]);
      const limitIndex = search.parameters.push(input.max_results + 1);
      const offsetIndex = search.parameters.push(offset);
      const runs = await rows<TrackingRun>(
        connection,
        `SELECT r.* FROM runs r WHERE r.project_id=$1 AND r.experiment_id=ANY($2::uuid[])
        AND ($3=3 OR r.lifecycle_stage=CASE WHEN $3=2 THEN 'deleted' ELSE 'active' END)
        AND ${search.filter} ORDER BY ${search.orderBy} LIMIT $${limitIndex} OFFSET $${offsetIndex}`,
        search.parameters,
      );
      const hasMore = runs.length > input.max_results;
      return {
        runs: await serializeRuns(connection, runs.slice(0, input.max_results)),
        ...(hasMore ? { next_page_token: nextPageToken(offset + input.max_results, query) } : {}),
      };
    });
  }
  async update(
    principal: Principal,
    projectId: string,
    input: { runId: string; status?: MlflowRunStatus; end_time?: number | null; run_name?: string },
  ) {
    return this.write({ principal, projectId, runId: input.runId }, async (connection, run) => {
      const job = await first(connection, 'SELECT id FROM jobs WHERE run_id=$1', [run.id]);
      const { status, startedAt, endedAt } = resolveTrackingLifecycle(run, {
        status: input.status,
        endTime: input.end_time,
        hasJob: !!job,
      });
      const tags = { ...run.tags };
      if (input.run_name !== undefined) tags['mlflow.runName'] = input.run_name;
      const updated = (await first<TrackingRun>(
        connection,
        `UPDATE runs SET name=COALESCE($2,name),tags=$3::jsonb,status=$4,ended_at=$5,
        started_at=$6 WHERE id=$1 RETURNING *`,
        [run.id, input.run_name, JSON.stringify(tags), status, endedAt, startedAt],
      ))!;
      if (status !== run.status) await enqueueRunEvent(connection, updated);
      return serializeRunInfo(updated);
    });
  }
  async batch(
    principal: Principal,
    projectId: string,
    input: TrackingBatch & { runId: string },
  ): Promise<void> {
    const hasParentTag = input.tags.some((tag) => tag.key === 'mlflow.parentRunId');
    await this.write(
      { principal, projectId, runId: input.runId },
      async (connection, run) => {
        const parameters = appendParameters(run, input.params);
        const job = await first(connection, 'SELECT id FROM jobs WHERE run_id=$1', [run.id]);
        const recordedParameters = job
          ? { ...run.recordedParameters, ...collectValues(input.params) }
          : run.recordedParameters;
        const tags = { ...run.tags, ...collectValues(input.tags) };
        const parentRunId = hasParentTag
          ? parse(uuidSchema, tags['mlflow.parentRunId'])
          : run.parentRunId;
        if (hasParentTag && parentRunId)
          await this.validateParent(connection, {
            projectId,
            experimentId: run.experimentId,
            parentRunId,
            runId: run.id,
          });
        const name = tags['mlflow.runName'] ?? run.name;
        await connection.query(
          'UPDATE runs SET parameters=$2::jsonb,tags=$3::jsonb,name=$4,parent_run_id=$5,recorded_parameters=$6::jsonb WHERE id=$1',
          [
            run.id,
            JSON.stringify(job ? run.parameters : parameters),
            JSON.stringify(tags),
            name,
            parentRunId,
            JSON.stringify(recordedParameters),
          ],
        );
        await appendTrackingMetrics(connection, run.id, input.metrics);
      },
      {
        lockParentage: hasParentTag,
        modelIds: input.metrics.flatMap((point) => (point.model_id ? [point.model_id] : [])),
      },
    );
  }
  async deleteTag(
    principal: Principal,
    projectId: string,
    input: { runId: string; key: string },
  ): Promise<void> {
    await this.write({ principal, projectId, runId: input.runId }, async (connection, run) => {
      if (!Object.hasOwn(run.tags, input.key)) notFound('Run Tag');
      await connection.query(
        "UPDATE runs SET tags=tags-$2::text,parent_run_id=CASE WHEN $2='mlflow.parentRunId' THEN NULL ELSE parent_run_id END WHERE id=$1",
        [run.id, input.key],
      );
    });
  }
  async setLifecycle(
    principal: Principal,
    projectId: string,
    input: { runId: string; lifecycleStage: 'active' | 'deleted' },
  ): Promise<void> {
    await this.write(
      { principal, projectId, runId: input.runId },
      async (connection, run) => {
        if (run.lifecycleStage === input.lifecycleStage)
          invalidParameter(`Runは既に${input.lifecycleStage}です`);
        const job = await first(
          connection,
          "SELECT id FROM jobs WHERE run_id=$1 AND status NOT IN ('finished','failed','canceled')",
          [run.id],
        );
        if (job && input.lifecycleStage === 'deleted') conflict('実行中のJobのRunは削除できません');
        await connection.query('UPDATE runs SET lifecycle_stage=$2 WHERE id=$1', [
          run.id,
          input.lifecycleStage,
        ]);
      },
      { allowDeleted: true },
    );
  }
  async history(
    principal: Principal,
    projectId: string,
    input: { runId: string; metricKey: string; maxResults?: number; pageToken?: string },
  ) {
    await requireProject(this.database, principal, { projectId, role: 'viewer', scope: 'read' });
    await findRun(this.database, { projectId, id: input.runId });
    return metricHistory(this.database, { ...input, projectId });
  }
  async inputs(
    principal: Principal,
    projectId: string,
    input: { runId: string; datasets: TrackingDatasetInput[]; models: { model_id: string }[] },
  ): Promise<void> {
    await this.write(
      { principal, projectId, runId: input.runId },
      async (connection, run) => {
        await logRunModels(connection, {
          projectId,
          runId: run.id,
          models: input.models,
          direction: 'input',
        });
        await logDatasetInputs(connection, this.registry, {
          principal,
          run,
          datasets: input.datasets,
        });
      },
      { modelIds: input.models.map((model) => model.model_id) },
    );
  }
  async outputs(
    principal: Principal,
    projectId: string,
    input: { runId: string; models: { model_id: string; step: number | string }[] },
  ): Promise<void> {
    await this.write(
      { principal, projectId, runId: input.runId },
      async (connection, run) => {
        await logRunModels(connection, {
          projectId,
          runId: run.id,
          models: input.models,
          direction: 'output',
        });
      },
      { modelIds: input.models.map((model) => model.model_id) },
    );
  }
  async logModel(
    principal: Principal,
    projectId: string,
    input: { runId: string; modelJson: string },
  ): Promise<void> {
    await this.write({ principal, projectId, runId: input.runId }, async (connection, run) => {
      let model: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(input.modelJson);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
          invalidParameter('model_jsonにはJSON objectが必要です');
        model = parsed as Record<string, unknown>;
      } catch {
        invalidParameter('model_jsonが不正です');
      }
      if (model.run_id && model.run_id !== run.id)
        invalidParameter('model_jsonのrun_idが一致しません');
      let history: unknown[];
      try {
        history = run.tags['mlflow.log-model.history']
          ? (JSON.parse(run.tags['mlflow.log-model.history']) as unknown[])
          : [];
      } catch {
        invalidParameter('既存model履歴が不正です');
      }
      if (!Array.isArray(history)) invalidParameter('既存model履歴が不正です');
      if (!history.some((entry) => JSON.stringify(entry) === JSON.stringify(model)))
        history.push(model);
      await connection.query('UPDATE runs SET tags=tags||$2::jsonb WHERE id=$1', [
        run.id,
        JSON.stringify({ 'mlflow.log-model.history': JSON.stringify(history) }),
      ]);
    });
  }
  private async read<T>(
    principal: Principal,
    projectId: string,
    operation: (connection: Connection) => Promise<T>,
  ): Promise<T> {
    return transaction(this.database, async (connection) => {
      // Get/search must expose params, metrics and inputs from the same committed batch.
      await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await requireProject(connection, principal, { projectId, role: 'viewer', scope: 'read' });
      return operation(connection);
    });
  }
  private async write<T>(
    reference: { principal: Principal; projectId: string; runId: string },
    operation: (connection: Connection, run: TrackingRun) => Promise<T>,
    options: { allowDeleted?: boolean; lockParentage?: boolean; modelIds?: string[] } = {},
  ): Promise<T> {
    const { principal, projectId, runId } = reference;
    return transaction(this.database, async (connection) => {
      await requireProject(connection, principal, {
        projectId,
        role: 'editor',
        scope: 'runs:write',
      });
      const existingRun = await findRun(connection, { projectId, id: runId });
      const experiment = await first<{ lifecycleStage: string }>(
        connection,
        'SELECT lifecycle_stage FROM experiments WHERE id=$1 AND project_id=$2 FOR SHARE',
        [existingRun.experimentId, projectId],
      );
      if (experiment?.lifecycleStage !== 'active')
        invalidParameter('削除済みExperimentのRunは変更できません');
      // Parent edits serialize before Run locks so simultaneous opposite edges cannot form a cycle.
      if (options.lockParentage)
        await connection.query('SELECT pg_advisory_xact_lock($1,hashtext($2))', [
          PARENT_RUN_LOCK_NAMESPACE,
          existingRun.experimentId,
        ]);
      // Artifact uploads also lock Run before model; NO KEY UPDATE permits Registry's Run FK lock.
      const run = await first<TrackingRun>(
        connection,
        'SELECT * FROM runs WHERE project_id=$1 AND id=$2 FOR NO KEY UPDATE',
        [projectId, runId],
      );
      if (!run) notFound('Run');
      if (!options.allowDeleted && run.lifecycleStage !== 'active')
        invalidParameter('削除済みRunは変更できません');
      const modelIds = [...new Set(options.modelIds ?? [])].sort();
      if (modelIds.length) {
        const models = await rows<{ id: string }>(
          connection,
          'SELECT id FROM mlflow_logged_models WHERE project_id=$1 AND id=ANY($2::text[]) AND deleted_at IS NULL ORDER BY id FOR SHARE',
          [projectId, modelIds],
        );
        if (models.length !== modelIds.length)
          invalidParameter('同じProjectのLogged Modelが必要です');
      }
      return operation(connection, run);
    });
  }
  private async validateParent(
    connection: Connection,
    request: { projectId: string; experimentId: string; parentRunId: string; runId?: string },
  ): Promise<void> {
    const parentRunId = parse(uuidSchema, request.parentRunId);
    const parent = (await findRun(connection, {
      projectId: request.projectId,
      id: parentRunId,
    })) as TrackingRun;
    if (parent.experimentId !== request.experimentId || parent.lifecycleStage !== 'active')
      invalidParameter('親Runは同じactive Experimentに属する必要があります');
    if (!request.runId) return;
    const cycle = await first(
      connection,
      `WITH RECURSIVE ancestors AS (
        SELECT id,parent_run_id FROM runs WHERE id=$1 AND project_id=$3
        UNION SELECT r.id,r.parent_run_id FROM runs r JOIN ancestors a ON r.id=a.parent_run_id WHERE r.project_id=$3
      ) SELECT id FROM ancestors WHERE id=$2`,
      [parentRunId, request.runId, request.projectId],
    );
    if (cycle) invalidParameter('parentRunIdに循環参照は指定できません');
  }
}
