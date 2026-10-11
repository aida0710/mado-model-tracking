import { randomUUID } from 'node:crypto';
import type {
  ComputeTarget,
  ExecutionRuntime,
  Job,
  JobListItem,
  Run,
  WorkerJob,
} from '@mmt/contracts';
import type { Principal } from '../auth/principal.js';
import type { ApiConfig } from '../config.js';
import { first, rows, transaction, type Connection, type Database } from '../db/database.js';
import { conflict, DomainError, notFound } from '../domain/errors.js';
import { validateCodeCompatibility } from '../domain/compatibility.js';
import { validateExecutionSnapshot } from '../domain/executionSnapshot.js';
import {
  validatePinnedRuntime,
  validateTargetCompatibility,
} from '../domain/runtimeCompatibility.js';
import { validateCodeArtifacts } from '../repositories/runtimeArtifactRepository.js';
import { isTerminalStatus } from '../domain/runTransitions.js';
import type { JobCreate } from '../domain/validation.js';
import {
  initialJobPhase,
  SUBMISSION_PHASES,
  validateSiteJobOptions,
} from '../domain/siteJobs.js';
import {
  findCodeVersion,
  findDatasetVersions,
  findModelVersion,
  findRun,
} from '../repositories/registryRepository.js';
import { findJob, jobColumns } from '../repositories/jobRepository.js';
import { shareLiveProject } from '../repositories/projectRepository.js';
import { findExecutionForRun } from '../repositories/automationExecutionLookup.js';
import { requireProject } from './accessService.js';
import { JobTokenService } from './jobTokenService.js';
import { assertTargetReadyForJobs } from './siteReadiness.js';
import { NO_IMAGE_PLATFORM_CHECK, type ImagePlatformChecker } from './imagePlatformChecker.js';
import type { RunCompletionService } from './runCompletionService.js';
import type { RunService } from './runService.js';
import { runColumns } from '../repositories/runListProjection.js';
import { SWEEP_EARLY_STOPPED_TAG } from './sweepController.js';
import type { JobRetryInput } from '../domain/checkpointValidation.js';
import {
  findWorkerInputCheckpoint,
  findWorkerResumeCheckpoint,
  pinResumeCheckpoint,
  selectRetryCheckpoint,
} from './checkpointResume.js';
import { findTriggerPayload } from '../repositories/hookExecutionRepository.js';

/** The Job fields a caller chooses: a JobCreate request, or a Task, rule, hook or driver launch. */
export type JobInsert = Pick<JobCreate, 'runId' | 'targetId' | 'gpuIds' | 'maxAttempts'> &
  Partial<
    Pick<
      JobCreate,
      'gpuCount' | 'walltimeSeconds' | 'retryOnFailure' | 'retryOnTimeout' | 'allowChildJobs'
    >
  >;

/** Where a Job stands among others. Only the server sets these (arrays, hooks, drivers). */
export interface JobPlacement {
  arrayGroupId?: string;
  arrayIndex?: number;
  hookId?: string | null;
  hookChain?: string[];
  parentJobId?: string | null;
  chainDepth?: number;
  datasetPartitionVersionId?: string | null;
  idempotencyKey?: string | null;
}

function assertRetryable(job: Job): void {
  if (!isTerminalStatus(job.status)) conflict('実行中または状態未確認のJobは再実行できません');
  if (job.attempt >= job.maxAttempts) conflict('Jobの最大試行回数に達しました');
}

/**
 * The parent of a retry Run. An automated Run's parent is its upstream (the training Run or the
 * upstream stage, or none), which the worker hands to the container, so its retries keep that
 * parent; other retries hang under the Run they retry.
 */
async function retryParentRunId(connection: Connection, previousRun: Run): Promise<string | null> {
  const execution = await findExecutionForRun(connection, {
    projectId: previousRun.projectId,
    runId: previousRun.id,
  });
  return execution ? previousRun.parentRunId : previousRun.id;
}

export class JobService {
  private readonly database: Database;
  private readonly runs: RunService;
  private readonly config: ApiConfig;
  private readonly runCompletion: RunCompletionService;
  private readonly jobTokens: JobTokenService;
  private readonly imagePlatforms: ImagePlatformChecker;
  constructor(options: {
    database: Database;
    runs: RunService;
    config: ApiConfig;
    runCompletion: RunCompletionService;
    jobTokens?: JobTokenService;
    imagePlatforms?: ImagePlatformChecker;
  }) {
    this.database = options.database;
    this.runs = options.runs;
    this.config = options.config;
    this.runCompletion = options.runCompletion;
    this.jobTokens = options.jobTokens ?? new JobTokenService(options.database);
    this.imagePlatforms = options.imagePlatforms ?? NO_IMAGE_PLATFORM_CHECK;
  }

  async list(principal: Principal, projectId: string): Promise<JobListItem[]> {
    await requireProject(this.database, principal, { projectId, role: 'viewer', scope: 'read' });
    // Every Job has a Run of the same Project; the Task is optional.
    return rows(
      this.database,
      `SELECT ${jobColumns('j')},r.name AS run_name,r.kind AS run_kind,r.task_id,t.name AS task_name,
        COALESCE(r.tags->>$2='true',false) AS sweep_early_stopped
      FROM jobs j JOIN runs r ON r.id=j.run_id
      LEFT JOIN experiment_tasks t ON t.id=r.task_id
      WHERE j.project_id=$1 ORDER BY j.created_at DESC`,
      [projectId, SWEEP_EARLY_STOPPED_TAG],
    );
  }

  async create(principal: Principal, projectId: string, input: JobCreate): Promise<Job> {
    return transaction(this.database, async (connection) => {
      await requireProject(connection, principal, {
        projectId,
        role: 'editor',
        scope: 'jobs:write',
      });
      const run = await findRun(connection, { projectId, id: input.runId, lock: true });
      return this.insertJob(connection, { run, input, attempt: 1 });
    });
  }

  async insertJob(
    connection: Connection,
    registration: { run: Run; input: JobInsert; attempt: number; placement?: JobPlacement },
  ): Promise<Job> {
    const { run, input, attempt } = registration;
    const placement = registration.placement ?? {};
    // Every Job, whether a person, a hook, automation or a sweep starts it, passes here; an
    // archived Project gets none, and an archive waiting on this lock then sees the new Job.
    if (!(await shareLiveProject(connection, run.projectId))) notFound('Project');
    const activeRun = await first(
      connection,
      "SELECT id FROM runs WHERE id=$1 AND project_id=$2 AND lifecycle_stage='active'",
      [run.id, run.projectId],
    );
    if (!activeRun) conflict('削除済みRunにはJobを作成できません');
    if (run.status !== 'queued') conflict('JobはqueuedのRunにだけ作成できます');
    // Reject duplicates before taking a target lock: a worker locks target before this existing Run.
    const existing = await first(connection, 'SELECT id FROM jobs WHERE run_id=$1', [run.id]);
    if (existing) conflict('Runには既にJobがあります');
    if (!run.codeVersionId)
      throw new DomainError(422, '実行するCodeVersionが必要です', 'code_required');
    const code = await findCodeVersion(connection, {
      projectId: run.projectId,
      id: run.codeVersionId,
    });
    const model = run.modelVersionId
      ? await findModelVersion(connection, { projectId: run.projectId, id: run.modelVersionId })
      : null;
    validateCodeCompatibility(code, { model, kind: run.kind });
    validatePinnedRuntime(code.runtime, run.environment.runtime);
    validateExecutionSnapshot(code, run);
    await validateCodeArtifacts(connection, code);
    await findDatasetVersions(connection, {
      projectId: run.projectId,
      ids: run.inputDatasetVersionIds,
    });
    const target = await this.validateTarget(connection, {
      targetId: input.targetId,
      gpuIds: input.gpuIds,
      gpuCount: input.gpuCount,
      retryOnFailure: input.retryOnFailure,
      retryOnTimeout: input.retryOnTimeout,
      runtime: code.runtime,
      usage: { projectId: run.projectId, userId: run.createdBy },
    });
    // ssh and local Jobs name their GPUs; a site Job asks only for a number.
    const gpuCount = target.executor === 'site' ? (input.gpuCount ?? 0) : input.gpuIds.length;
    return (await first<Job>(
      connection,
      `INSERT INTO jobs(project_id,run_id,target_id,gpu_ids,max_attempts,attempt,phase,gpu_count,walltime_seconds,
        retry_on_failure,retry_on_timeout,allow_child_jobs,array_group_id,array_index,hook_id,hook_chain,
        parent_job_id,chain_depth,dataset_partition_version_id,idempotency_key)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING ${jobColumns()}`,
      [
        run.projectId,
        run.id,
        input.targetId,
        input.gpuIds,
        input.maxAttempts,
        attempt,
        initialJobPhase(target),
        gpuCount,
        input.walltimeSeconds ?? null,
        input.retryOnFailure ?? false,
        input.retryOnTimeout ?? false,
        input.allowChildJobs ?? false,
        placement.arrayGroupId ?? null,
        placement.arrayIndex ?? null,
        placement.hookId ?? null,
        placement.hookChain ?? [],
        placement.parentJobId ?? null,
        placement.chainDepth ?? 0,
        placement.datasetPartitionVersionId ?? null,
        placement.idempotencyKey ?? null,
      ],
    ))!;
  }

  /**
   * `usage` is whose Jobs will run there: the Run's creator (a rule's, hook's or Sweep's owner),
   * who must be allowed to use the computer in the Project.
   */
  async validateTarget(
    connection: Connection,
    execution: {
      targetId: string;
      gpuIds: string[];
      runtime: ExecutionRuntime;
      gpuCount?: number;
      retryOnFailure?: boolean;
      retryOnTimeout?: boolean;
      usage: { projectId: string; userId: string };
    },
  ): Promise<ComputeTarget> {
    const target = await first<ComputeTarget>(
      connection,
      'SELECT * FROM compute_targets WHERE id=$1 AND enabled=true FOR SHARE',
      [execution.targetId],
    );
    if (!target) notFound('ComputeTarget');
    validateTargetCompatibility(target, {
      runtime: execution.runtime,
      gpuIds: execution.gpuIds,
      allowLocalExecutor: this.config.allowLocalExecutor,
    });
    validateSiteJobOptions(target, {
      gpuCount: execution.gpuCount ?? 0,
      retryOnFailure: execution.retryOnFailure ?? false,
      retryOnTimeout: execution.retryOnTimeout ?? false,
    });
    // An image for another CPU would fail only on the compute node, after the queue wait.
    await this.imagePlatforms.assertRunsOn(execution.runtime, target);
    await assertTargetReadyForJobs(connection, { target, ...execution.usage });
    return target;
  }

  async cancel(principal: Principal, projectId: string, jobId: string): Promise<Job> {
    return transaction(this.database, async (connection) => {
      await requireProject(connection, principal, {
        projectId,
        role: 'editor',
        scope: 'jobs:write',
      });
      return this.requestCancelInTransaction(connection, { projectId, jobId });
    });
  }

  /**
   * Shared by the cancel API and server-side cancellation (sweeps); authorization is the caller's.
   * A driver's unfinished child Jobs are canceled with it, so nothing keeps running for a parent
   * that was stopped.
   */
  async requestCancelInTransaction(
    connection: Connection,
    reference: { projectId: string; jobId: string },
  ): Promise<Job> {
    const job = await this.cancelOne(connection, reference);
    const children = await rows<{ id: string }>(
      connection,
      `SELECT id FROM jobs WHERE parent_job_id=$1 AND status IN ('queued','claimed','running')
      ORDER BY created_at,id`,
      [job.id],
    );
    for (const child of children)
      await this.requestCancelInTransaction(connection, {
        projectId: reference.projectId,
        jobId: child.id,
      });
    return job;
  }

  private async cancelOne(
    connection: Connection,
    reference: { projectId: string; jobId: string },
  ): Promise<Job> {
    const { projectId } = reference;
    const job = await findJob(connection, { projectId, id: reference.jobId, lock: true });
    if (isTerminalStatus(job.status)) return job;
    // A site Job that is being submitted or waits in the scheduler queue runs nothing yet, so it
    // ends now; the launcher removes the queued scheduler job (scheduler_cancel_state).
    const waitsInSchedulerQueue = !!job.phase && SUBMISSION_PHASES.includes(job.phase);
    if (job.status !== 'queued' && !waitsInSchedulerQueue) {
      // Even a silent worker may still own a live remote process. Only completion releases its reservation.
      return (await first<Job>(
        connection,
        `UPDATE jobs SET cancel_requested=true WHERE id=$1 RETURNING ${jobColumns()}`,
        [job.id],
      ))!;
    }
    const previousRun = await findRun(connection, { projectId, id: job.runId, lock: true });
    const canceled = (await first<Job>(
      connection,
      `UPDATE jobs SET status='canceled',cancel_requested=true,ended_at=now(),
        scheduler_cancel_state=CASE WHEN scheduler_job_id IS NULL THEN NULL ELSE 'pending' END
      WHERE id=$1 RETURNING ${jobColumns()}`,
      [job.id],
    ))!;
    const run = (await first<Run>(
      connection,
      `UPDATE runs SET status='canceled',ended_at=now() WHERE id=$1 RETURNING ${runColumns}`,
      [job.runId],
    ))!;
    await this.runCompletion.recordStatusChange(connection, {
      previousStatus: previousRun.status,
      run,
    });
    return canceled;
  }

  /** A retry is a new Run; with a checkpoint it continues from that step instead of step 0. */
  async retry(
    principal: Principal,
    projectId: string,
    request: { jobId: string; input: JobRetryInput },
  ): Promise<{ run: Run; job: Job }> {
    const { jobId, input: retryRequest } = request;
    return transaction(this.database, async (connection) => {
      await requireProject(connection, principal, {
        projectId,
        role: 'editor',
        scope: 'jobs:write',
      });
      const previousJob = await findJob(connection, { projectId, id: jobId, lock: true });
      const existingRetry = await first<Job>(
        connection,
        `SELECT ${jobColumns()} FROM jobs WHERE retry_of_job_id=$1`,
        [previousJob.id],
      );
      const previousRun = await findRun(connection, { projectId, id: previousJob.runId });
      if (existingRetry) {
        const retryRun = await findRun(connection, { projectId, id: existingRetry.runId });
        await this.assertSameRetryCheckpoint(connection, {
          projectId,
          previousRun,
          retryRun,
          request: retryRequest,
        });
        return { job: existingRetry, run: retryRun };
      }
      assertRetryable(previousJob);
      const checkpointId = await selectRetryCheckpoint(connection, {
        projectId,
        previousRun,
        request: retryRequest,
      });
      return this.insertRetry(connection, {
        previousJob,
        previousRun,
        createdBy: principal.user.id,
        checkpointId,
      });
    });
  }

  /**
   * Creates the next attempt of a finished Job as a new Run and Job, linked by retry_of_job_id.
   * Shared by the retry API and automatic retries; authorization, the duplicate check, and the
   * checkpoint choice are the caller's. The unique retry_of_job_id still refuses a second retry.
   */
  async insertRetry(
    connection: Connection,
    retry: { previousJob: Job; previousRun: Run; createdBy: string; checkpointId: string | null },
  ): Promise<{ run: Run; job: Job }> {
    const { previousJob, previousRun, checkpointId } = retry;
    assertRetryable(previousJob);
    const projectId = previousRun.projectId;
    const insertedRun = await this.runs.insertRun(connection, {
      projectId,
      createdBy: retry.createdBy,
      ...(previousRun.taskId && previousRun.taskRevision
        ? { task: { id: previousRun.taskId, revision: previousRun.taskRevision } }
        : {}),
      input: {
        experimentId: previousRun.experimentId,
        name: `${previousRun.name} (retry ${previousJob.attempt + 1})`,
        kind: previousRun.kind,
        parameters: previousRun.parameters,
        tags: previousRun.tags,
        modelVersionId: previousRun.modelVersionId,
        codeVersionId: previousRun.codeVersionId,
        executionMode: previousRun.executionMode ?? 'run',
        inputDatasetVersionIds: previousRun.inputDatasetVersionIds,
        parentRunId: await retryParentRunId(connection, previousRun),
        environment: previousRun.environment,
      },
      // A retried chained evaluation keeps the reference set apart from the upstream outputs,
      // so promotion and baseline comparison still match it against the rule's inputs.
      upstreamDatasetVersionIds: previousRun.upstreamDatasetVersionIds,
    });
    const run = checkpointId
      ? await pinResumeCheckpoint(connection, { run: insertedRun, checkpointId })
      : insertedRun;
    const previous = (await first<{ hookChain: string[]; executor: ComputeTarget['executor'] }>(
      connection,
      'SELECT j.hook_chain,t.executor FROM jobs j JOIN compute_targets t ON t.id=j.target_id WHERE j.id=$1',
      [previousJob.id],
    ))!;
    const isSiteJob = previous.executor === 'site';
    const job = await this.insertJob(connection, {
      run,
      input: {
        runId: run.id,
        targetId: previousJob.targetId,
        // A site Job's gpuIds are what its runner was given, not what the Job asked for.
        gpuIds: isSiteJob ? [] : previousJob.gpuIds,
        maxAttempts: previousJob.maxAttempts,
        ...(isSiteJob
          ? {
              gpuCount: previousJob.gpuCount,
              retryOnFailure: previousJob.retryOnFailure,
              retryOnTimeout: previousJob.retryOnTimeout,
            }
          : {}),
        walltimeSeconds: previousJob.walltimeSeconds,
        allowChildJobs: previousJob.allowChildJobs,
      },
      attempt: previousJob.attempt + 1,
      // A retry keeps its array index, hook and driver, so the group and the chain still see it.
      placement: {
        ...(previousJob.arrayGroupId !== null && previousJob.arrayIndex !== null
          ? { arrayGroupId: previousJob.arrayGroupId, arrayIndex: previousJob.arrayIndex }
          : {}),
        hookId: previousJob.hookId,
        hookChain: previous.hookChain,
        parentJobId: previousJob.parentJobId,
        chainDepth: previousJob.chainDepth,
        datasetPartitionVersionId: previousJob.datasetPartitionVersionId,
      },
    });
    await connection.query('UPDATE jobs SET retry_of_job_id=$2 WHERE id=$1', [
      job.id,
      previousJob.id,
    ]);
    return { run, job };
  }

  // Resending the same retry returns the Run it created; asking for another checkpoint is refused.
  private async assertSameRetryCheckpoint(
    connection: Connection,
    retry: { projectId: string; previousRun: Run; retryRun: Run; request: JobRetryInput },
  ): Promise<void> {
    const { request } = retry;
    if (!request.checkpointId && !request.resumeFromLatestCheckpoint) return;
    const requested = await selectRetryCheckpoint(connection, retry);
    if ((retry.retryRun.resumeCheckpointId ?? null) !== requested)
      throw new DomainError(409, 'このJobは別の条件で再実行済みです', 'job_already_retried');
  }

  async getWorkerJob(connection: Connection, job: Job): Promise<WorkerJob> {
    const run = await findRun(connection, { projectId: job.projectId, id: job.runId });
    const target = await first<ComputeTarget>(
      connection,
      'SELECT * FROM compute_targets WHERE id=$1',
      [job.targetId],
    );
    if (!target || !run.codeVersionId)
      throw new DomainError(503, 'Jobの実行設定を確認できません', 'invalid_job');
    const codeVersion = await findCodeVersion(connection, {
      projectId: job.projectId,
      id: run.codeVersionId,
    });
    const modelVersion = run.modelVersionId
      ? await findModelVersion(connection, { projectId: job.projectId, id: run.modelVersionId })
      : null;
    validateCodeCompatibility(codeVersion, {
      model: modelVersion,
      kind: run.kind,
    });
    validatePinnedRuntime(codeVersion.runtime, run.environment.runtime);
    validateExecutionSnapshot(codeVersion, run);
    validateTargetCompatibility(target, {
      runtime: codeVersion.runtime,
      gpuIds: job.gpuIds,
      allowLocalExecutor: this.config.allowLocalExecutor,
    });
    await validateCodeArtifacts(connection, codeVersion);
    const inputDatasets = await findDatasetVersions(connection, {
      projectId: job.projectId,
      ids: run.inputDatasetVersionIds,
    });
    const resumeCheckpoint = await findWorkerResumeCheckpoint(connection, run);
    const inputCheckpoint = await findWorkerInputCheckpoint(connection, run);
    const triggerPayload = await findTriggerPayload(connection, job);
    const jobToken = await this.jobTokens.issueForWorker(connection, job);
    return {
      job,
      run,
      target,
      codeVersion,
      modelVersion,
      inputDatasets,
      jobToken,
      resumeCheckpoint,
      inputCheckpoint,
      triggerPayload,
    };
  }

  async reserveJob(
    connection: Connection,
    reservation: { job: Job; tokenId: string; workerId: string },
  ): Promise<Job> {
    const leaseId = randomUUID();
    const { job } = reservation;
    const previousRun = await findRun(connection, {
      projectId: job.projectId,
      id: job.runId,
      lock: true,
    });
    const claimed = (await first<Job>(
      connection,
      `UPDATE jobs SET status='claimed',worker_id=$2,lease_id=$3,worker_token_id=$4,started_at=now(),heartbeat_at=now()
      WHERE id=$1 RETURNING ${jobColumns()}`,
      [job.id, reservation.workerId, leaseId, reservation.tokenId],
    ))!;
    if (job.gpuIds.length)
      await connection.query(
        'INSERT INTO gpu_reservations(target_id,gpu_id,job_id) SELECT $1,unnest($2::text[]),$3',
        [job.targetId, job.gpuIds, job.id],
      );
    const run = (await first<Run>(
      connection,
      `UPDATE runs SET status='running',started_at=COALESCE(started_at,now()) WHERE id=$1 RETURNING ${runColumns}`,
      [job.runId],
    ))!;
    await this.runCompletion.recordStatusChange(connection, {
      previousStatus: previousRun.status,
      run,
    });
    return claimed;
  }
}
