import type {
  CodeVersion,
  LogEntry,
  MetricPoint,
  ModelVersion,
  Run,
  RunStatus,
} from '@mmt/contracts';
import type { Principal } from '../auth/principal.js';
import { first, rows, transaction, type Connection, type Database } from '../db/database.js';
import { conflict, DomainError } from '../domain/errors.js';
import { createExecutionSnapshot } from '../domain/executionSnapshot.js';
import { assertNoReservedRunTags } from '../domain/reservedRunTags.js';
import type { RunCreate, RunPatch } from '../domain/validation.js';
import { validateCodeCompatibility } from '../domain/compatibility.js';
import { validatePinnedRuntime } from '../domain/runtimeCompatibility.js';
import { validateCodeArtifacts } from '../repositories/runtimeArtifactRepository.js';
import { runColumns, runSummarySelect } from '../repositories/runListProjection.js';
import { isTerminalStatus, validateRunTransition } from '../domain/runTransitions.js';
import {
  assertProjectReference,
  assertProjectReferences,
  findCodeVersion,
  findModelVersion,
  findRun,
  lockActiveExperiment,
} from '../repositories/registryRepository.js';
import {
  appendLogs,
  appendMetrics,
  listLogs,
  listMetrics,
} from '../repositories/telemetryRepository.js';
import { requireProject } from './accessService.js';
import type { RunCompletionService } from './runCompletionService.js';
import { pinResumeCheckpoint } from './checkpointResume.js';

/**
 * Job-owned Runs are the evidence automation and evaluation compare, so their records freeze once
 * the Run is terminal. Runs without a Job stay writable after they end, as in MLflow.
 */
export async function assertRunRecordsWritable(
  connection: Connection,
  run: Pick<Run, 'id' | 'status'>,
): Promise<void> {
  if (!isTerminalStatus(run.status)) return;
  const job = await first(connection, 'SELECT id FROM jobs WHERE run_id=$1', [run.id]);
  if (job)
    throw new DomainError(409, 'Jobが終了したRunには記録を追加・変更できません', 'run_finalized');
}

export class RunService {
  constructor(
    private readonly database: Database,
    private readonly runCompletion: RunCompletionService,
  ) {}

  async list(
    principal: Principal,
    projectId: string,
    filter: {
      experimentId?: string;
      status?: RunStatus;
      query?: string;
      limit: number;
    },
  ): Promise<Run[]> {
    await requireProject(this.database, principal, { projectId, role: 'viewer', scope: 'read' });
    if (filter.experimentId)
      await assertProjectReference(this.database, {
        table: 'experiments',
        projectId,
        id: filter.experimentId,
      });
    return rows(
      this.database,
      `${runSummarySelect} WHERE project_id=$1 AND lifecycle_stage='active' AND ($2::uuid IS NULL OR experiment_id=$2)
      AND ($3::text IS NULL OR status=$3) AND ($4::text IS NULL OR name ILIKE '%'||$4||'%') ORDER BY created_at DESC,id DESC LIMIT $5`,
      [
        projectId,
        filter.experimentId ?? null,
        filter.status ?? null,
        filter.query ?? null,
        filter.limit,
      ],
    );
  }

  async create(principal: Principal, projectId: string, input: RunCreate): Promise<Run> {
    assertNoReservedRunTags(input.tags);
    return transaction(this.database, async (connection) => {
      await requireProject(connection, principal, {
        projectId,
        role: 'editor',
        scope: 'runs:write',
      });
      const run = await this.insertRun(connection, {
        projectId,
        createdBy: principal.user.id,
        input,
      });
      return input.resumeCheckpointId
        ? pinResumeCheckpoint(connection, { run, checkpointId: input.resumeCheckpointId })
        : run;
    });
  }

  async insertRun(
    connection: Connection,
    registration: {
      // Chosen by an offline client so a resend finds the same Run; the database picks one otherwise.
      id?: string;
      projectId: string;
      createdBy: string;
      input: RunCreate;
      task?: { id: string; revision: number };
      // Inputs that came from an upstream Run's outputs (chained automation); a subset of the inputs.
      upstreamDatasetVersionIds?: string[];
    },
  ): Promise<Run> {
    const { projectId, input } = registration;
    await lockActiveExperiment(connection, { projectId, id: input.experimentId });
    await assertProjectReferences(connection, {
      table: 'dataset_versions',
      projectId,
      ids: input.inputDatasetVersionIds,
    });
    if (input.parentRunId) await findRun(connection, { projectId, id: input.parentRunId });
    let model: ModelVersion | null = null;
    let code: CodeVersion | null = null;
    if (input.modelVersionId)
      model = await findModelVersion(connection, { projectId, id: input.modelVersionId });
    const codeVersionId = input.codeVersionId ?? model?.defaultCodeVersionId;
    if (codeVersionId)
      code = await findCodeVersion(connection, {
        projectId,
        id: codeVersionId,
      });
    if (code) {
      validateCodeCompatibility(code, { model, kind: input.kind });
      await validateCodeArtifacts(connection, code);
      if (input.environment.runtime !== undefined)
        validatePinnedRuntime(code.runtime, input.environment.runtime);
    }
    const mode = input.executionMode ?? 'run';
    if (!code && mode === 'test')
      throw new DomainError(422, 'テストにはCodeVersionが必要です', 'code_required');
    const snapshot = code ? createExecutionSnapshot(code, mode) : null;
    return (await first<Run>(
      connection,
      `INSERT INTO runs(id,project_id,experiment_id,name,kind,parameters,tags,model_version_id,code_version_id,input_dataset_version_ids,parent_run_id,environment,created_by,execution_mode,execution_snapshot,task_id,task_revision,upstream_dataset_version_ids)
      VALUES(COALESCE($18::uuid,gen_random_uuid()),$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING ${runColumns}`,
      [
        projectId,
        input.experimentId,
        input.name,
        input.kind,
        JSON.stringify(input.parameters),
        JSON.stringify(input.tags),
        model?.id ?? null,
        code?.id ?? null,
        input.inputDatasetVersionIds,
        input.parentRunId ?? null,
        JSON.stringify(code ? { ...input.environment, runtime: code.runtime } : input.environment),
        registration.createdBy,
        mode,
        snapshot ? JSON.stringify(snapshot) : null,
        registration.task?.id ?? null,
        registration.task?.revision ?? null,
        registration.upstreamDatasetVersionIds ?? [],
        registration.id ?? null,
      ],
    ))!;
  }

  async get(principal: Principal, projectId: string, runId: string): Promise<Run> {
    await requireProject(this.database, principal, { projectId, role: 'viewer', scope: 'read' });
    return findRun(this.database, { projectId, id: runId });
  }

  async patch(
    principal: Principal,
    projectId: string,
    registration: { runId: string; input: RunPatch },
  ): Promise<Run> {
    const input = registration.input;
    if (input.tags) assertNoReservedRunTags(input.tags);
    return transaction(this.database, async (connection) => {
      await requireProject(connection, principal, {
        projectId,
        role: 'editor',
        scope: 'runs:write',
      });
      const run = await findRun(connection, { projectId, id: registration.runId, lock: true });
      if (input.tags || input.parameters) await assertRunRecordsWritable(connection, run);
      const isMlflowManaged = (run as Run & { mlflowManaged?: boolean }).mlflowManaged === true;
      if (isMlflowManaged && input.parameters) {
        for (const [key, value] of Object.entries(input.parameters)) {
          if (typeof value !== 'string') conflict('MLflowのparamはstringで記録してください');
          if (Object.hasOwn(run.parameters, key) && run.parameters[key] !== value)
            conflict('記録済みMLflowのparamは変更できません');
        }
      }
      let tags = input.tags && { ...input.tags };
      const name = input.name ?? input.tags?.['mlflow.runName'];
      if (name !== undefined && (isMlflowManaged || Object.hasOwn(run.tags, 'mlflow.runName')))
        (tags ??= {})['mlflow.runName'] = name;
      if (input.environment?.runtime !== undefined && run.codeVersionId) {
        const code = await findCodeVersion(connection, {
          projectId,
          id: run.codeVersionId,
        });
        validatePinnedRuntime(code.runtime, input.environment.runtime);
      }
      const environment = input.environment && {
        ...input.environment,
        ...(run.codeVersionId ? { runtime: run.environment.runtime } : {}),
      };
      const status = input.status ?? run.status;
      const job = await first<{ status: string }>(
        connection,
        'SELECT status FROM jobs WHERE run_id=$1',
        [run.id],
      );
      if (job && job.status !== 'queued' && (input.parameters || input.environment))
        conflict('Job実行開始後は実行設定を変更できません');
      if (input.status) {
        if (job) conflict('Jobが管理するRunの状態は変更できません');
        validateRunTransition(run.status, status);
      }
      const updated = (await first<Run>(
        connection,
        `UPDATE runs SET name=COALESCE($2,name),tags=tags||COALESCE($3::jsonb,'{}'::jsonb),environment=COALESCE($4::jsonb,environment),parameters=parameters||COALESCE($7::jsonb,'{}'::jsonb),
        status=$5, started_at=CASE WHEN $5='running' THEN COALESCE(started_at,now()) ELSE started_at END,
        ended_at=CASE WHEN $6 THEN COALESCE(ended_at,now()) ELSE ended_at END WHERE id=$1 RETURNING ${runColumns}`,
        [
          run.id,
          name,
          tags ? JSON.stringify(tags) : null,
          environment ? JSON.stringify(environment) : null,
          status,
          isTerminalStatus(status),
          input.parameters ? JSON.stringify(input.parameters) : null,
        ],
      ))!;
      if (status !== run.status)
        await this.runCompletion.recordStatusChange(connection, {
          previousStatus: run.status,
          run: updated,
        });
      return updated;
    });
  }

  async metrics(principal: Principal, projectId: string, runId: string): Promise<MetricPoint[]> {
    await this.get(principal, projectId, runId);
    return listMetrics(this.database, runId);
  }

  async addMetrics(
    principal: Principal,
    projectId: string,
    registration: { runId: string; metrics: MetricPoint[] },
  ): Promise<void> {
    await this.writeTelemetry(principal, {
      projectId,
      runId: registration.runId,
      isRunRecord: true,
      append: (connection) => appendMetrics(connection, registration.runId, registration.metrics),
    });
  }

  async logs(principal: Principal, projectId: string, runId: string): Promise<LogEntry[]> {
    await this.get(principal, projectId, runId);
    return listLogs(this.database, runId);
  }

  async addLogs(
    principal: Principal,
    projectId: string,
    registration: { runId: string; entries: LogEntry[] },
  ): Promise<void> {
    await this.writeTelemetry(principal, {
      projectId,
      runId: registration.runId,
      isRunRecord: false,
      append: (connection) => appendLogs(connection, registration.runId, registration.entries),
    });
  }

  private async writeTelemetry(
    principal: Principal,
    request: {
      projectId: string;
      runId: string;
      // Logs are diagnostics nothing compares, so only records (metrics) freeze with the Job.
      isRunRecord: boolean;
      append: (connection: Connection) => Promise<void>;
    },
  ): Promise<void> {
    await transaction(this.database, async (connection) => {
      await requireProject(connection, principal, {
        projectId: request.projectId,
        role: 'editor',
        scope: 'runs:write',
      });
      const run = await findRun(connection, {
        projectId: request.projectId,
        id: request.runId,
        lock: true,
      });
      if (request.isRunRecord) await assertRunRecordsWritable(connection, run);
      await request.append(connection);
    });
  }
}
