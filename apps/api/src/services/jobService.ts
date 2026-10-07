import { randomUUID } from 'node:crypto';
import type { ComputeTarget, Job, Run, WorkerJob } from '@mmt/contracts';
import type { Principal } from '../auth/principal.js';
import type { ApiConfig } from '../config.js';
import { first, rows, transaction, type Connection, type Database } from '../db/database.js';
import { conflict, DomainError, notFound } from '../domain/errors.js';
import { validateCodeCompatibility } from '../domain/compatibility.js';
import { isTerminalStatus } from '../domain/runTransitions.js';
import type { JobCreate } from '../domain/validation.js';
import {
  findCodeVersion,
  findDatasetVersions,
  findModelVersion,
  findRun,
} from '../repositories/registryRepository.js';
import { findJob, jobColumns } from '../repositories/jobRepository.js';
import { requireProject } from './accessService.js';
import { enqueueRunEvent } from './outboxEvents.js';
import type { RunService } from './runService.js';

export class JobService {
  constructor(
    private readonly database: Database,
    private readonly runs: RunService,
    private readonly config: ApiConfig,
  ) {}

  async list(principal: Principal, projectId: string): Promise<Job[]> {
    await requireProject(this.database, principal, { projectId, role: 'viewer', scope: 'read' });
    return rows(
      this.database,
      `SELECT ${jobColumns()} FROM jobs WHERE project_id=$1 ORDER BY created_at DESC`,
      [projectId],
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
    registration: { run: Run; input: JobCreate; attempt: number },
  ): Promise<Job> {
    const { run, input, attempt } = registration;
    if (run.status !== 'queued') conflict('JobはqueuedのRunにだけ作成できます');
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
    await findDatasetVersions(connection, {
      projectId: run.projectId,
      ids: run.inputDatasetVersionIds,
    });
    const target = await first<ComputeTarget>(
      connection,
      'SELECT * FROM compute_targets WHERE id=$1 AND enabled=true',
      [input.targetId],
    );
    if (!target) notFound('ComputeTarget');
    if (target.executor === 'local' && !this.config.allowLocalExecutor)
      throw new DomainError(422, 'Local executorは無効です', 'local_executor_disabled');
    if (input.gpuIds.some((gpu) => !target.gpuIds.includes(gpu)))
      throw new DomainError(422, 'Targetに存在しないGPUが指定されています', 'unknown_gpu');
    const existing = await first(connection, 'SELECT id FROM jobs WHERE run_id=$1', [run.id]);
    if (existing) conflict('Runには既にJobがあります');
    return (await first<Job>(
      connection,
      `INSERT INTO jobs(project_id,run_id,target_id,gpu_ids,max_attempts,attempt) VALUES($1,$2,$3,$4,$5,$6) RETURNING ${jobColumns()}`,
      [run.projectId, run.id, input.targetId, input.gpuIds, input.maxAttempts, attempt],
    ))!;
  }

  async cancel(principal: Principal, projectId: string, jobId: string): Promise<Job> {
    return transaction(this.database, async (connection) => {
      await requireProject(connection, principal, {
        projectId,
        role: 'editor',
        scope: 'jobs:write',
      });
      const job = await findJob(connection, { projectId, id: jobId, lock: true });
      if (isTerminalStatus(job.status)) return job;
      if (job.status !== 'queued') {
        // Even a silent worker may still own a live remote process. Only completion releases its reservation.
        return (await first<Job>(
          connection,
          `UPDATE jobs SET cancel_requested=true WHERE id=$1 RETURNING ${jobColumns()}`,
          [job.id],
        ))!;
      }
      await findRun(connection, { projectId, id: job.runId, lock: true });
      const canceled = (await first<Job>(
        connection,
        `UPDATE jobs SET status='canceled',cancel_requested=true,ended_at=now() WHERE id=$1 RETURNING ${jobColumns()}`,
        [job.id],
      ))!;
      const run = (await first<Run>(
        connection,
        "UPDATE runs SET status='canceled',ended_at=now() WHERE id=$1 RETURNING *",
        [job.runId],
      ))!;
      await enqueueRunEvent(connection, run);
      return canceled;
    });
  }

  async retry(
    principal: Principal,
    projectId: string,
    jobId: string,
  ): Promise<{ run: Run; job: Job }> {
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
      if (existingRetry)
        return {
          job: existingRetry,
          run: await findRun(connection, { projectId, id: existingRetry.runId }),
        };
      if (!isTerminalStatus(previousJob.status))
        conflict('実行中または状態未確認のJobは再実行できません');
      if (previousJob.attempt >= previousJob.maxAttempts) conflict('Jobの最大試行回数に達しました');
      const previousRun = await findRun(connection, { projectId, id: previousJob.runId });
      const run = await this.runs.insertRun(connection, {
        projectId,
        createdBy: principal.user.id,
        input: {
          experimentId: previousRun.experimentId,
          name: `${previousRun.name} (retry ${previousJob.attempt + 1})`,
          kind: previousRun.kind,
          parameters: previousRun.parameters,
          tags: previousRun.tags,
          modelVersionId: previousRun.modelVersionId,
          codeVersionId: previousRun.codeVersionId,
          inputDatasetVersionIds: previousRun.inputDatasetVersionIds,
          parentRunId: previousRun.id,
          environment: previousRun.environment,
        },
      });
      const job = await this.insertJob(connection, {
        run,
        input: {
          runId: run.id,
          targetId: previousJob.targetId,
          gpuIds: previousJob.gpuIds,
          maxAttempts: previousJob.maxAttempts,
        },
        attempt: previousJob.attempt + 1,
      });
      await connection.query('UPDATE jobs SET retry_of_job_id=$2 WHERE id=$1', [
        job.id,
        previousJob.id,
      ]);
      return { run, job };
    });
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
    const inputDatasets = await findDatasetVersions(connection, {
      projectId: job.projectId,
      ids: run.inputDatasetVersionIds,
    });
    return { job, run, target, codeVersion, modelVersion, inputDatasets };
  }

  async reserveJob(
    connection: Connection,
    reservation: { job: Job; tokenId: string; workerId: string },
  ): Promise<Job> {
    const leaseId = randomUUID();
    const { job } = reservation;
    await findRun(connection, { projectId: job.projectId, id: job.runId, lock: true });
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
      "UPDATE runs SET status='running',started_at=COALESCE(started_at,now()) WHERE id=$1 RETURNING *",
      [job.runId],
    ))!;
    await enqueueRunEvent(connection, run);
    return claimed;
  }
}
