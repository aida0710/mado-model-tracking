import type {
  CodeVersion,
  ExperimentTask,
  Run,
  RunKind,
  TaskExecution,
  TaskOutputModel,
  TaskRunPage,
} from '@mmt/contracts';
import type { Principal } from '../auth/principal.js';
import { first, rows, transaction, type Connection, type Database } from '../db/database.js';
import { validateCodeCompatibility } from '../domain/compatibility.js';
import { conflict, DomainError, notFound } from '../domain/errors.js';
import { assertNoReservedRunTags } from '../domain/reservedRunTags.js';
import {
  MAX_TASK_REVISION,
  type TaskCreate,
  type TaskDefaults,
  type TaskHistoryQuery,
  type TaskLaunch,
  type TaskPatch,
} from '../domain/experimentTaskValidation.js';
import { findTask, insertTask, updateTask } from '../repositories/experimentTaskRepository.js';
import {
  assertProjectReferences,
  findCodeVersion,
  findModelVersion,
  lockActiveExperiment,
} from '../repositories/registryRepository.js';
import { validateCodeArtifacts } from '../repositories/runtimeArtifactRepository.js';
import { runSummarySelect } from '../repositories/runListProjection.js';
import {
  findOutputModelById,
  findOutputModelByName,
} from '../repositories/runOutputRegistrationRepository.js';
import { requireProject, requireScope } from './accessService.js';
import type { JobService } from './jobService.js';
import type { RunService } from './runService.js';

// Task launch and ordinary Job creation share the same retry policy.
const TASK_JOB_MAX_ATTEMPTS = 3;
// Same kinds registerModelVersion accepts as an output model's source Run.
const OUTPUT_MODEL_TASK_KINDS: readonly RunKind[] = ['training', 'finetuning'];

/** Launch overrides once the revision check is done. */
export type TaskLaunchOptions = Omit<TaskLaunch, 'expectedRevision'>;

export class TaskService {
  constructor(
    private readonly database: Database,
    private readonly runs: RunService,
    private readonly jobs: JobService,
  ) {}

  async list(
    principal: Principal,
    projectId: string,
    experimentId?: string,
  ): Promise<ExperimentTask[]> {
    await requireProject(this.database, principal, { projectId, role: 'viewer', scope: 'read' });
    if (experimentId) {
      const experiment = await first(
        this.database,
        'SELECT id FROM experiments WHERE id=$1 AND project_id=$2',
        [experimentId, projectId],
      );
      if (!experiment) notFound('Experiment');
    }
    return rows(
      this.database,
      `SELECT * FROM experiment_tasks WHERE project_id=$1 AND ($2::uuid IS NULL OR experiment_id=$2) ORDER BY created_at DESC,id DESC`,
      [projectId, experimentId ?? null],
    );
  }

  async get(principal: Principal, projectId: string, taskId: string): Promise<ExperimentTask> {
    await requireProject(this.database, principal, { projectId, role: 'viewer', scope: 'read' });
    return findTask(this.database, { projectId, id: taskId });
  }

  async create(
    principal: Principal,
    projectId: string,
    input: TaskCreate,
  ): Promise<ExperimentTask> {
    return transaction(this.database, async (connection) => {
      await requireProject(connection, principal, {
        projectId,
        role: 'editor',
        scope: 'registry:write',
      });
      await lockActiveExperiment(connection, { projectId, id: input.experimentId });
      await this.validateDefaults(connection, { projectId, input });
      return insertTask(connection, { projectId, input });
    });
  }

  async patch(
    principal: Principal,
    projectId: string,
    request: { taskId: string; input: TaskPatch },
  ): Promise<ExperimentTask> {
    return transaction(this.database, async (connection) => {
      await requireProject(connection, principal, {
        projectId,
        role: 'editor',
        scope: 'registry:write',
      });
      const task = await this.lockTask(connection, { projectId, id: request.taskId });
      this.validateRevision(task, request.input.expectedRevision);
      if (task.revision === MAX_TASK_REVISION) conflict('Taskのrevision上限に達しました');
      const { expectedRevision: _expectedRevision, ...changes } = request.input;
      const updated = {
        ...task,
        ...changes,
        outputModel:
          changes.outputModel === undefined ? (task.outputModel ?? null) : changes.outputModel,
      };
      await this.validateDefaults(connection, { projectId, input: updated });
      return updateTask(connection, updated);
    });
  }

  async launch(
    principal: Principal,
    projectId: string,
    request: { taskId: string; input: TaskLaunch },
  ): Promise<TaskExecution> {
    return transaction(this.database, async (connection) => {
      await requireProject(connection, principal, {
        projectId,
        role: 'editor',
        scope: 'runs:write',
      });
      requireScope(principal, 'jobs:write');
      const task = await this.lockTask(connection, { projectId, id: request.taskId });
      const { expectedRevision, ...input } = request.input;
      this.validateRevision(task, expectedRevision);
      return this.launchTaskInTransaction(connection, {
        task,
        input,
        createdBy: principal.user.id,
      });
    });
  }

  /**
   * Creates the Run and Job of one Task launch. The caller has authorized the launch, locked the
   * Task's Experiment and checked its revision. serverTags are reserved tags (mmt.*) that only
   * server-side launchers such as sweeps set; they are added on top of the Task's tags.
   */
  async launchTaskInTransaction(
    connection: Connection,
    launch: {
      task: ExperimentTask;
      input: TaskLaunchOptions;
      createdBy: string;
      serverTags?: Record<string, string>;
    },
  ): Promise<TaskExecution> {
    const { task, input } = launch;
    const targetId = input.targetId ?? task.targetId;
    if (!targetId)
      throw new DomainError(422, '実行するComputeTargetを指定してください', 'target_required');
    const run = await this.runs.insertRun(connection, {
      projectId: task.projectId,
      createdBy: launch.createdBy,
      task: { id: task.id, revision: task.revision },
      input: {
        experimentId: task.experimentId,
        name: input.name ?? task.name,
        kind: task.kind,
        codeVersionId: task.codeVersionId,
        executionMode: input.executionMode,
        modelVersionId:
          input.modelVersionId === undefined ? task.modelVersionId : input.modelVersionId,
        inputDatasetVersionIds: input.inputDatasetVersionIds ?? task.inputDatasetVersionIds,
        parameters: { ...task.parameters, ...input.parameters },
        tags: { ...task.tags, ...launch.serverTags },
        environment: {},
      },
    });
    const job = await this.jobs.insertJob(connection, {
      run,
      input: {
        runId: run.id,
        targetId,
        gpuIds: input.gpuIds ?? task.gpuIds,
        maxAttempts: TASK_JOB_MAX_ATTEMPTS,
      },
      attempt: 1,
    });
    return { run, job };
  }

  async history(
    principal: Principal,
    projectId: string,
    request: TaskHistoryQuery & { taskId: string },
  ): Promise<TaskRunPage> {
    await this.get(principal, projectId, request.taskId);
    // Preserve PostgreSQL microseconds; JavaScript Date would truncate the keyset boundary.
    const boundary = request.cursor
      ? await first<{ id: string; createdAt: string }>(
          this.database,
          'SELECT id,created_at::text AS created_at FROM runs WHERE project_id=$1 AND task_id=$2 AND id=$3',
          [projectId, request.taskId, request.cursor],
        )
      : undefined;
    if (request.cursor && !boundary) notFound('Run cursor');
    const page = await rows<Run>(
      this.database,
      `${runSummarySelect} WHERE project_id=$1 AND task_id=$2 AND lifecycle_stage='active'
      AND ($3::timestamptz IS NULL OR (created_at,id)<($3::timestamptz,$4::uuid))
      ORDER BY created_at DESC,id DESC LIMIT $5`,
      [
        projectId,
        request.taskId,
        boundary?.createdAt ?? null,
        boundary?.id ?? null,
        request.limit + 1,
      ],
    );
    const items = page.slice(0, request.limit);
    return {
      items,
      nextCursor: page.length > request.limit ? items.at(-1)!.id : null,
    };
  }

  private async lockTask(
    connection: Connection,
    reference: { projectId: string; id: string },
  ): Promise<ExperimentTask> {
    const task = await findTask(connection, reference);
    // Experiment precedes Task and Run locks, matching MLflow lifecycle mutations.
    await lockActiveExperiment(connection, {
      projectId: reference.projectId,
      id: task.experimentId,
    });
    return findTask(connection, { ...reference, lock: true });
  }

  private validateRevision(task: ExperimentTask, expectedRevision: number): void {
    if (task.revision !== expectedRevision)
      throw new DomainError(
        409,
        'Taskが更新されています。最新のrevisionを確認してください',
        'task_revision_conflict',
      );
  }

  private async validateDefaults(
    connection: Connection,
    registration: { projectId: string; input: TaskDefaults },
  ): Promise<void> {
    const { projectId, input } = registration;
    const code = await findCodeVersion(connection, { projectId, id: input.codeVersionId });
    const model = input.modelVersionId
      ? await findModelVersion(connection, { projectId, id: input.modelVersionId })
      : null;
    validateCodeCompatibility(code, { model, kind: input.kind });
    await validateCodeArtifacts(connection, code);
    assertNoReservedRunTags(input.tags);
    if (input.outputModel)
      await this.validateOutputModel(connection, {
        projectId,
        kind: input.kind,
        code,
        outputModel: input.outputModel,
      });
    await assertProjectReferences(connection, {
      table: 'dataset_versions',
      projectId,
      ids: input.inputDatasetVersionIds,
    });
    if (input.targetId)
      await this.jobs.validateTarget(connection, {
        targetId: input.targetId,
        gpuIds: input.gpuIds,
        runtime: code.runtime,
      });
  }

  // The registration itself runs later as the Run's creator; checking here turns a Task that
  // could never register into a 422 at save time instead of a failed record after training.
  private async validateOutputModel(
    connection: Connection,
    request: { projectId: string; kind: RunKind; code: CodeVersion; outputModel: TaskOutputModel },
  ): Promise<void> {
    const { projectId, code, outputModel } = request;
    if (!OUTPUT_MODEL_TASK_KINDS.includes(request.kind))
      throw new DomainError(
        422,
        '出力モデルはtrainingまたはfinetuningのTaskでのみ設定できます',
        'output_model_kind',
      );
    const family = outputModel.createModel
      ? await familyForNewModel(connection, { projectId, createModel: outputModel.createModel })
      : await familyOfExistingModel(connection, { projectId, id: outputModel.modelId! });
    validateCodeCompatibility(code, { model: { family } });
    if (outputModel.defaultCodeVersionId)
      validateCodeCompatibility(
        await findCodeVersion(connection, { projectId, id: outputModel.defaultCodeVersionId }),
        { model: { family } },
      );
  }
}

async function familyOfExistingModel(
  connection: Connection,
  reference: { projectId: string; id: string },
): Promise<string> {
  const model = await findOutputModelById(connection, reference);
  if (!model) notFound('Model');
  if (model.deleted)
    throw new DomainError(422, 'MLflowで削除したModelは登録先にできません', 'model_deleted');
  return model.family;
}

// An existing Model with the same name is reused at registration, so its family must match.
async function familyForNewModel(
  connection: Connection,
  request: { projectId: string; createModel: { name: string; family: string } },
): Promise<string> {
  const { createModel } = request;
  const existing = await findOutputModelByName(connection, {
    projectId: request.projectId,
    name: createModel.name,
  });
  if (existing && existing.family !== createModel.family)
    throw new DomainError(
      422,
      `同じ名前のModelが系列${existing.family}で登録されています`,
      'model_family_mismatch',
    );
  return createModel.family;
}
