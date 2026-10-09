import type {
  Job,
  JobPhase,
  LogEntry,
  MetricPoint,
  Run,
  RunOutputDeclaration,
  RunnerFinishResult,
  RunnerState,
} from '@mmt/contracts';
import type { PoolClient } from 'pg';
import type { Principal } from '../auth/principal.js';
import { first, transaction, type Connection, type Database } from '../db/database.js';
import { conflict, DomainError } from '../domain/errors.js';
import { isTerminalStatus } from '../domain/runTransitions.js';
import type {
  RunnerFinishInput,
  RunnerHeartbeatInput,
  RunnerStartInput,
} from '../domain/siteExecutionValidation.js';
import type { ParsedOutputDeclaration } from '../domain/workerOutputValidation.js';
import { findLatestCheckpointId } from '../repositories/checkpointRepository.js';
import { findJob, jobColumns } from '../repositories/jobRepository.js';
import { findRun } from '../repositories/registryRepository.js';
import { runColumns } from '../repositories/runListProjection.js';
import { appendLogs, appendMetrics } from '../repositories/telemetryRepository.js';
import { requireProject } from './accessService.js';
import type { JobService } from './jobService.js';
import type { RunCompletionService } from './runCompletionService.js';
import type { RunOutputDeclarationService } from './runOutputDeclarationService.js';

interface JobReference {
  projectId: string;
  jobId: string;
}

const RETRY_SAVEPOINT = 'runner_retry';
// Phases a runner moves through, in order; a report never moves a Job back.
const RUNNER_PHASE_ORDER: readonly JobPhase[] = ['waiting_resources', 'running'];

function sameId(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function laterPhase(current: JobPhase | null, requested: JobPhase | undefined): JobPhase | null {
  if (!requested) return current;
  if (!current || !RUNNER_PHASE_ORDER.includes(current)) return requested;
  return RUNNER_PHASE_ORDER.indexOf(requested) > RUNNER_PHASE_ORDER.indexOf(current)
    ? requested
    : current;
}

/**
 * Reports from the runner on a site's compute node (docs/sites.md). The runner authenticates with
 * its Job's token and names the instance ID it chose at start, so a second copy of the runner
 * (a requeued scheduler job) cannot write into a Job another runner holds. The runner never hands
 * the instance ID to the container, which holds the same Job token.
 */
export class RunnerService {
  private readonly database: Database;
  private readonly jobs: JobService;
  private readonly runCompletion: RunCompletionService;
  private readonly outputDeclarations: RunOutputDeclarationService;
  constructor(options: {
    database: Database;
    jobs: JobService;
    runCompletion: RunCompletionService;
    outputDeclarations: RunOutputDeclarationService;
  }) {
    this.database = options.database;
    this.jobs = options.jobs;
    this.runCompletion = options.runCompletion;
    this.outputDeclarations = options.outputDeclarations;
  }

  async start(
    principal: Principal,
    reference: JobReference,
    request: RunnerStartInput,
  ): Promise<RunnerState> {
    return transaction(this.database, async (connection) => {
      const { job, runnerInstanceId } = await this.lockJob(connection, principal, reference);
      if (isTerminalStatus(job.status))
        throw new DomainError(409, 'Jobは既に終了しています', 'job_not_startable');
      if (runnerInstanceId && !sameId(runnerInstanceId, request.instanceId))
        throw new DomainError(409, '別のrunnerがこのJobを実行しています', 'runner_conflict');
      const started = (await first<Job>(
        connection,
        `UPDATE jobs SET runner_instance_id=$2,runner_host=$3,gpu_ids=$4,phase=$5,heartbeat_at=now(),
          started_at=COALESCE(started_at,now())
        WHERE id=$1 RETURNING ${jobColumns()}`,
        [job.id, request.instanceId, request.host, request.gpuIds, laterPhase(job.phase, request.phase)],
      ))!;
      return { job: await this.markRunning(connection, started), cancelRequested: started.cancelRequested };
    });
  }

  async heartbeat(
    principal: Principal,
    reference: JobReference,
    request: RunnerHeartbeatInput,
  ): Promise<RunnerState> {
    return transaction(this.database, async (connection) => {
      const job = await this.lockRunningJob(connection, principal, {
        ...reference,
        instanceId: request.instanceId,
      });
      const updated = (await first<Job>(
        connection,
        `UPDATE jobs SET heartbeat_at=now(),phase=$2,gpu_ids=COALESCE($3,gpu_ids)
        WHERE id=$1 RETURNING ${jobColumns()}`,
        [job.id, laterPhase(job.phase, request.phase), request.gpuIds ?? null],
      ))!;
      return { job: await this.markRunning(connection, updated), cancelRequested: updated.cancelRequested };
    });
  }

  async logs(
    principal: Principal,
    reference: JobReference,
    request: { instanceId: string; entries: LogEntry[] },
  ): Promise<void> {
    await this.writeTelemetry(principal, {
      ...reference,
      instanceId: request.instanceId,
      append: (connection, runId) => appendLogs(connection, runId, request.entries),
    });
  }

  async metrics(
    principal: Principal,
    reference: JobReference,
    request: { instanceId: string; metrics: MetricPoint[] },
  ): Promise<void> {
    await this.writeTelemetry(principal, {
      ...reference,
      instanceId: request.instanceId,
      append: (connection, runId) => appendMetrics(connection, runId, request.metrics),
    });
  }

  async outputs(
    principal: Principal,
    reference: JobReference,
    request: { instanceId: string; declarations: ParsedOutputDeclaration[] },
  ): Promise<RunOutputDeclaration[]> {
    return transaction(this.database, async (connection) => {
      const job = await this.lockRunningJob(connection, principal, {
        ...reference,
        instanceId: request.instanceId,
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

  /**
   * Ends the Job and its Run. A Job asked to cancel ends as canceled unless it finished. A timed
   * out Job with retryOnTimeout continues from its latest checkpoint; a failed one with
   * retryOnFailure starts again from where this attempt started, both up to maxAttempts.
   */
  async finish(
    principal: Principal,
    reference: JobReference,
    request: RunnerFinishInput,
  ): Promise<RunnerFinishResult> {
    if (request.status === 'finished' && request.exitCode !== undefined && request.exitCode !== 0)
      throw new DomainError(
        422,
        '非zeroのexitCodeでJobを成功にはできません',
        'inconsistent_completion',
      );
    return transaction(this.database, async (connection) => {
      const { job, runnerInstanceId } = await this.lockJob(connection, principal, reference);
      if (!runnerInstanceId || !sameId(runnerInstanceId, request.instanceId))
        throw new DomainError(409, '別のrunnerがこのJobを実行しています', 'runner_conflict');
      const timedOut = request.endReason === 'timed_out';
      const reported = timedOut ? 'failed' : request.status;
      const status = job.cancelRequested && reported !== 'finished' ? 'canceled' : reported;
      if (isTerminalStatus(job.status)) {
        if (job.status !== status) conflict('完了済みJobと再送された状態が一致しません');
        return { job, retryJobId: await this.findRetryJobId(connection, job.id) };
      }
      const previousRun = await findRun(connection, {
        projectId: job.projectId,
        id: job.runId,
        lock: true,
      });
      const endReason = timedOut && status === 'failed' ? 'timed_out' : null;
      const completed = (await first<Job>(
        connection,
        `UPDATE jobs SET status=$2,exit_code=$3,error=$4,end_reason=$5,ended_at=now(),heartbeat_at=now()
        WHERE id=$1 RETURNING ${jobColumns()}`,
        [job.id, status, request.exitCode ?? null, request.error ?? null, endReason],
      ))!;
      // The retry exists before the Run ends, so completion handlers (arrays, hooks) see it.
      const retryJobId = await this.retryAutomatically(connection, {
        job: completed,
        previousRun,
      });
      const run = (await first<Run>(
        connection,
        `UPDATE runs SET status=$2,error=$3,ended_at=now() WHERE id=$1 RETURNING ${runColumns}`,
        [job.runId, status, request.error ?? null],
      ))!;
      await connection.query('DELETE FROM gpu_reservations WHERE job_id=$1', [job.id]);
      await this.runCompletion.recordStatusChange(connection, {
        previousStatus: previousRun.status,
        run,
      });
      return { job: completed, retryJobId };
    });
  }

  private async retryAutomatically(
    connection: PoolClient,
    ended: { job: Job; previousRun: Run },
  ): Promise<string | null> {
    const { job, previousRun } = ended;
    const timedOut = job.endReason === 'timed_out';
    const wanted = job.status === 'failed' && (timedOut ? job.retryOnTimeout : job.retryOnFailure);
    if (!wanted || job.cancelRequested || job.attempt >= job.maxAttempts) return null;
    const checkpointId = timedOut
      ? ((await findLatestCheckpointId(connection, {
          projectId: job.projectId,
          runId: job.runId,
        })) ?? previousRun.resumeCheckpointId)
      : previousRun.resumeCheckpointId;
    await connection.query(`SAVEPOINT ${RETRY_SAVEPOINT}`);
    try {
      const retry = await this.jobs.insertRetry(connection, {
        previousJob: job,
        previousRun,
        createdBy: previousRun.createdBy,
        checkpointId: checkpointId ?? null,
      });
      await connection.query(`RELEASE SAVEPOINT ${RETRY_SAVEPOINT}`);
      return retry.job.id;
    } catch (error) {
      await connection.query(`ROLLBACK TO SAVEPOINT ${RETRY_SAVEPOINT}`);
      if (!(error instanceof DomainError)) throw error;
      // The Job still ends; a retry that cannot start (for example an archived input) is skipped.
      console.error(
        JSON.stringify({ event: 'site_job_retry_skipped', jobId: job.id, code: error.code }),
      );
      return null;
    }
  }

  private async findRetryJobId(connection: Connection, jobId: string): Promise<string | null> {
    const retry = await first<{ id: string }>(
      connection,
      'SELECT id FROM jobs WHERE retry_of_job_id=$1',
      [jobId],
    );
    return retry?.id ?? null;
  }

  // The container started: the Job and its Run run from now on (claim alone left the Run queued).
  private async markRunning(connection: Connection, job: Job): Promise<Job> {
    if (job.phase !== 'running' || job.status === 'running') return job;
    const previousRun = await findRun(connection, {
      projectId: job.projectId,
      id: job.runId,
      lock: true,
    });
    const running = (await first<Job>(
      connection,
      `UPDATE jobs SET status='running' WHERE id=$1 RETURNING ${jobColumns()}`,
      [job.id],
    ))!;
    if (previousRun.status === 'queued') {
      const run = (await first<Run>(
        connection,
        `UPDATE runs SET status='running',started_at=COALESCE(started_at,now()) WHERE id=$1 RETURNING ${runColumns}`,
        [job.runId],
      ))!;
      await this.runCompletion.recordStatusChange(connection, {
        previousStatus: previousRun.status,
        run,
      });
    }
    return running;
  }

  /** Only the Job's own token may report for it, and only for a site Job (one with a phase). */
  private async lockJob(
    connection: Connection,
    principal: Principal,
    reference: JobReference,
  ): Promise<{ job: Job; runnerInstanceId: string | null }> {
    const binding = principal.token?.job;
    if (
      !binding ||
      !principal.token?.projectId ||
      !sameId(binding.jobId, reference.jobId) ||
      !sameId(principal.token.projectId, reference.projectId)
    )
      throw new DomainError(403, 'このJobのJob tokenが必要です', 'runner_token_required');
    const job = await findJob(connection, {
      projectId: reference.projectId,
      id: reference.jobId,
      lock: true,
    });
    if (job.phase === null)
      throw new DomainError(403, 'runnerの報告はsiteのJobだけです', 'runner_token_required');
    const runner = (await first<{ runnerInstanceId: string | null }>(
      connection,
      'SELECT runner_instance_id FROM jobs WHERE id=$1',
      [job.id],
    ))!;
    return { job, runnerInstanceId: runner.runnerInstanceId };
  }

  private async lockRunningJob(
    connection: Connection,
    principal: Principal,
    reference: JobReference & { instanceId: string },
  ): Promise<Job> {
    const { job, runnerInstanceId } = await this.lockJob(connection, principal, reference);
    if (!runnerInstanceId || !sameId(runnerInstanceId, reference.instanceId))
      throw new DomainError(409, '別のrunnerがこのJobを実行しています', 'runner_conflict');
    if (isTerminalStatus(job.status)) conflict('Jobは既に終了しています');
    return job;
  }

  private async writeTelemetry(
    principal: Principal,
    request: JobReference & {
      instanceId: string;
      append: (connection: Connection, runId: string) => Promise<void>;
    },
  ): Promise<void> {
    await transaction(this.database, async (connection) => {
      const job = await this.lockRunningJob(connection, principal, request);
      await findRun(connection, { projectId: job.projectId, id: job.runId, lock: true });
      await request.append(connection, job.runId);
    });
  }
}
