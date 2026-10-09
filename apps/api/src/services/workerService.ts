import type {
  ComputeTarget,
  Job,
  LogEntry,
  MetricPoint,
  Run,
  RunOutputDeclaration,
  WorkerJob,
  WorkerPresence,
} from '@mmt/contracts';
import type { z } from 'zod';
import type { Principal } from '../auth/principal.js';
import type { ApiConfig } from '../config.js';
import { first, rows, transaction, type Database, type Connection } from '../db/database.js';
import { conflict, DomainError } from '../domain/errors.js';
import { isTerminalStatus } from '../domain/runTransitions.js';
import type {
  completeSchema,
  workerClaimSchema,
  workerResumeSchema,
} from '../domain/validation.js';
import type { WorkerOutputsInput } from '../domain/workerOutputValidation.js';
import { jobColumns } from '../repositories/jobRepository.js';
import { findRun } from '../repositories/registryRepository.js';
import { appendLogs, appendMetrics } from '../repositories/telemetryRepository.js';
import {
  listWorkerPresence,
  touchWorker,
  touchWorkerLastSeen,
} from '../repositories/workerPresenceRepository.js';
import { requireGlobalAdmin, requireProject, requireWorker } from './accessService.js';
import type { JobService } from './jobService.js';
import type { RunCompletionService } from './runCompletionService.js';
import type { RunOutputDeclarationService } from './runOutputDeclarationService.js';
import { runColumns } from '../repositories/runListProjection.js';

// A busy target should not block claims for other targets in the same queue.
const CLAIM_CANDIDATE_LIMIT = 100;
// Site Jobs (executor 'site', a phase once claimed) belong to launchers and runners
// (SiteSubmissionService, RunnerService); a worker neither claims nor reports for them.

export class WorkerService {
  private readonly database: Database;
  private readonly jobs: JobService;
  private readonly config: ApiConfig;
  private readonly runCompletion: RunCompletionService;
  private readonly outputDeclarations: RunOutputDeclarationService;
  constructor(options: {
    database: Database;
    jobs: JobService;
    config: ApiConfig;
    runCompletion: RunCompletionService;
    outputDeclarations: RunOutputDeclarationService;
  }) {
    this.database = options.database;
    this.jobs = options.jobs;
    this.config = options.config;
    this.runCompletion = options.runCompletion;
    this.outputDeclarations = options.outputDeclarations;
  }

  async resume(
    principal: Principal,
    request: z.infer<typeof workerResumeSchema>,
  ): Promise<WorkerJob[]> {
    return transaction(this.database, async (connection) => {
      const worker = await requireWorker(connection, principal);
      await this.recordPresence(connection, worker, request);
      const activeJobs = await rows<Job>(
        connection,
        `SELECT ${jobColumns()} FROM jobs WHERE project_id=$1 AND worker_token_id=$2 AND worker_id=$3
        AND status IN ('claimed','running') AND phase IS NULL
        AND ($4::uuid[] IS NULL OR target_id=ANY($4::uuid[])) ORDER BY created_at`,
        [worker.projectId, worker.tokenId, request.workerId, request.targetIds ?? null],
      );
      const resumed: WorkerJob[] = [];
      for (const job of activeJobs) {
        if (!(await this.localExecutorDisabled(connection, job.targetId)))
          resumed.push(await this.jobs.getWorkerJob(connection, job));
      }
      return resumed;
    });
  }

  async claim(
    principal: Principal,
    request: z.infer<typeof workerClaimSchema>,
  ): Promise<WorkerJob | null> {
    return transaction(this.database, async (connection) => {
      const worker = await requireWorker(connection, principal);
      // Serializes a worker's duplicate HTTP requests, while other workers can use SKIP LOCKED.
      await connection.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `${worker.tokenId}:${request.workerId}`,
      ]);
      await this.recordPresence(connection, worker, request);
      const activeJobIds = request.activeJobIds ?? [];
      if (activeJobIds.length) {
        const monitored = await rows<{ id: string }>(
          connection,
          'SELECT id FROM jobs WHERE id=ANY($1::uuid[]) AND project_id=$2 AND worker_token_id=$3 AND worker_id=$4',
          [activeJobIds, worker.projectId, worker.tokenId, request.workerId],
        );
        if (monitored.length !== activeJobIds.length)
          throw new DomainError(
            409,
            '監視中Jobのworkerまたはprojectが一致しません',
            'invalid_active_jobs',
          );
      }
      const active = await first<Job>(
        connection,
        `SELECT ${jobColumns()} FROM jobs WHERE project_id=$1 AND worker_token_id=$2 AND worker_id=$3
        AND status IN ('claimed','running') AND phase IS NULL AND NOT(id=ANY($4::uuid[]))
        ORDER BY created_at LIMIT 1 FOR UPDATE`,
        [worker.projectId, worker.tokenId, request.workerId, activeJobIds],
      );
      if (active) {
        if (request.targetIds && !request.targetIds.includes(active.targetId))
          conflict('Workerには指定target以外の未完了Jobがあります');
        if (await this.localExecutorDisabled(connection, active.targetId))
          conflict('未完了のlocal Jobがありますがlocal executorは無効です');
        return this.jobs.getWorkerJob(connection, active);
      }
      const skipped: string[] = [];
      for (let candidateIndex = 0; candidateIndex < CLAIM_CANDIDATE_LIMIT; candidateIndex++) {
        const job = await first<Job>(
          connection,
          `SELECT ${jobColumns('j')} FROM jobs j JOIN compute_targets t ON t.id=j.target_id
          JOIN runs r ON r.id=j.run_id AND r.project_id=j.project_id
          JOIN code_versions c ON c.id=r.code_version_id AND c.project_id=r.project_id
          WHERE j.project_id=$1 AND j.status='queued' AND t.enabled AND t.executor<>'site'
          AND ($2::uuid[] IS NULL OR j.target_id=ANY($2::uuid[]))
          AND c.runtime->>'kind'=ANY(t.runtime_kinds)
          AND ($4 OR t.executor<>'local') AND NOT(j.id=ANY($3::uuid[]))
          AND (SELECT count(*) FROM jobs active WHERE active.target_id=t.id AND active.status IN ('claimed','running')) < t.max_concurrent_jobs
          AND NOT EXISTS(SELECT 1 FROM gpu_reservations g WHERE g.target_id=t.id AND g.gpu_id=ANY(j.gpu_ids))
          ORDER BY j.created_at,j.id LIMIT 1 FOR UPDATE OF j SKIP LOCKED`,
          [worker.projectId, request.targetIds ?? null, skipped, this.config.allowLocalExecutor],
        );
        if (!job) return null;
        skipped.push(job.id);
        const target = await first<ComputeTarget>(
          connection,
          'SELECT * FROM compute_targets WHERE id=$1 AND enabled=true FOR UPDATE SKIP LOCKED',
          [job.targetId],
        );
        if (!target) continue;
        const occupancy = (await first<{ count: number }>(
          connection,
          "SELECT count(*)::int AS count FROM jobs WHERE target_id=$1 AND status IN ('claimed','running')",
          [target.id],
        ))!;
        const gpuConflict = await first(
          connection,
          'SELECT job_id FROM gpu_reservations WHERE target_id=$1 AND gpu_id=ANY($2::text[]) LIMIT 1',
          [target.id, job.gpuIds],
        );
        if (occupancy.count >= target.maxConcurrentJobs || gpuConflict) continue;
        const claimed = await this.jobs.reserveJob(connection, {
          job,
          tokenId: worker.tokenId,
          workerId: request.workerId,
        });
        return this.jobs.getWorkerJob(connection, claimed);
      }
      return null;
    });
  }

  async heartbeat(
    principal: Principal,
    jobId: string,
    request: { leaseId: string; status?: 'running' },
  ): Promise<{ cancelRequested: boolean }> {
    return transaction(this.database, async (connection) => {
      const job = await this.verifyLease(connection, principal, {
        jobId,
        leaseId: request.leaseId,
      });
      if (isTerminalStatus(job.status)) conflict('Jobは既に終了しています');
      await touchWorkerLastSeen(connection, { jobId: job.id });
      await connection.query(
        'UPDATE jobs SET heartbeat_at=now(),status=COALESCE($2,status) WHERE id=$1',
        [job.id, request.status],
      );
      return { cancelRequested: job.cancelRequested };
    });
  }

  async listProjectWorkers(principal: Principal, projectId: string): Promise<WorkerPresence[]> {
    await requireProject(this.database, principal, { projectId, role: 'viewer', scope: 'read' });
    return listWorkerPresence(this.database, { projectId });
  }

  async listAllWorkers(principal: Principal): Promise<WorkerPresence[]> {
    requireGlobalAdmin(principal);
    return listWorkerPresence(this.database, { projectId: null });
  }

  async metrics(
    principal: Principal,
    jobId: string,
    request: { leaseId: string; metrics: MetricPoint[] },
  ): Promise<void> {
    await this.writeTelemetry(principal, {
      jobId,
      leaseId: request.leaseId,
      append: (connection, runId) => appendMetrics(connection, runId, request.metrics),
    });
  }

  async logs(
    principal: Principal,
    jobId: string,
    request: { leaseId: string; entries: LogEntry[] },
  ): Promise<void> {
    await this.writeTelemetry(principal, {
      jobId,
      leaseId: request.leaseId,
      append: (connection, runId) => appendLogs(connection, runId, request.entries),
    });
  }

  // Registering versions is a registry write, so the worker token needs registry:write as well.
  async outputs(
    principal: Principal,
    jobId: string,
    request: WorkerOutputsInput,
  ): Promise<RunOutputDeclaration[]> {
    return transaction(this.database, async (connection) => {
      const job = await this.verifyLease(connection, principal, {
        jobId,
        leaseId: request.leaseId,
      });
      await requireProject(connection, principal, {
        projectId: job.projectId,
        role: 'editor',
        scope: 'registry:write',
      });
      return this.outputDeclarations.register(connection, {
        job,
        declarations: request.declarations,
      });
    });
  }

  async complete(
    principal: Principal,
    jobId: string,
    request: z.infer<typeof completeSchema>,
  ): Promise<Job> {
    if (request.status === 'finished' && request.exitCode !== undefined && request.exitCode !== 0)
      throw new DomainError(
        422,
        '非zeroのexitCodeでJobを成功にはできません',
        'inconsistent_completion',
      );
    return transaction(this.database, async (connection) => {
      const job = await this.verifyLease(connection, principal, {
        jobId,
        leaseId: request.leaseId,
      });
      if (isTerminalStatus(job.status)) {
        if (job.status !== request.status) conflict('完了済みJobと再送された状態が一致しません');
        return job;
      }
      const previousRun = await findRun(connection, {
        projectId: job.projectId,
        id: job.runId,
        lock: true,
      });
      const completed = (await first<Job>(
        connection,
        `UPDATE jobs SET status=$2,exit_code=$3,error=$4,ended_at=now(),heartbeat_at=now() WHERE id=$1 RETURNING ${jobColumns()}`,
        [job.id, request.status, request.exitCode ?? null, request.error ?? null],
      ))!;
      const run = (await first<Run>(
        connection,
        `UPDATE runs SET status=$2,error=$3,ended_at=now() WHERE id=$1 RETURNING ${runColumns}`,
        [job.runId, request.status, request.error ?? null],
      ))!;
      await connection.query('DELETE FROM gpu_reservations WHERE job_id=$1', [job.id]);
      await this.runCompletion.recordStatusChange(connection, {
        previousStatus: previousRun.status,
        run,
      });
      return completed;
    });
  }

  private async recordPresence(
    connection: Connection,
    worker: { projectId: string; tokenId: string },
    request: z.infer<typeof workerResumeSchema>,
  ): Promise<void> {
    await touchWorker(connection, {
      projectId: worker.projectId,
      tokenId: worker.tokenId,
      workerId: request.workerId,
      targetIds: request.targetIds ?? null,
      ...request.workerInfo,
    });
  }

  private async verifyLease(
    connection: Connection,
    principal: Principal,
    lease: { jobId: string; leaseId: string },
  ): Promise<Job> {
    const worker = await requireWorker(connection, principal);
    const job = await first<Job>(
      connection,
      `SELECT ${jobColumns()} FROM jobs WHERE id=$1 AND project_id=$2 AND worker_token_id=$3 AND lease_id=$4
      AND phase IS NULL FOR UPDATE`,
      [lease.jobId, worker.projectId, worker.tokenId, lease.leaseId],
    );
    if (!job) throw new DomainError(409, 'Jobのleaseが無効です', 'invalid_lease');
    return job;
  }

  private async writeTelemetry(
    principal: Principal,
    request: {
      jobId: string;
      leaseId: string;
      append: (connection: Connection, runId: string) => Promise<void>;
    },
  ): Promise<void> {
    await transaction(this.database, async (connection) => {
      const job = await this.verifyLease(connection, principal, request);
      if (isTerminalStatus(job.status)) conflict('Jobは既に終了しています');
      await findRun(connection, { projectId: job.projectId, id: job.runId, lock: true });
      await request.append(connection, job.runId);
    });
  }

  private async localExecutorDisabled(connection: Connection, targetId: string): Promise<boolean> {
    const target = await first<{ executor: string }>(
      connection,
      'SELECT executor FROM compute_targets WHERE id=$1',
      [targetId],
    );
    return target?.executor === 'local' && !this.config.allowLocalExecutor;
  }
}
