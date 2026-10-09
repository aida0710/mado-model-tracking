import {
  MAX_ACTIVE_CHILD_JOBS,
  MAX_CHILD_JOBS_PER_PARENT,
  MAX_JOB_CHAIN_DEPTH,
  type ChildJobCreated,
  type ChildJobWait,
  type Job,
  type JobStatusCounts,
} from '@mmt/contracts';
import type { Principal } from '../auth/principal.js';
import { first, rows, transaction, type Connection, type Database } from '../db/database.js';
import { DomainError } from '../domain/errors.js';
import type { ChildJobCreateInput } from '../domain/hookValidation.js';
import { assertNoReservedRunTags } from '../domain/reservedRunTags.js';
import { findJob, jobColumns } from '../repositories/jobRepository.js';
import { findRun } from '../repositories/registryRepository.js';
import { requireProject } from './accessService.js';
import type { JobArrayService } from './jobArrayService.js';
import type { JobService } from './jobService.js';
import type { RunService } from './runService.js';

interface JobReference {
  projectId: string;
  jobId: string;
}

// A waiting driver asks the database about once a second; children take minutes to hours.
const WAIT_POLL_INTERVAL_MS = 1000;
const ACTIVE_STATUSES = ['queued', 'claimed', 'running'];

function sameId(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Drivers (docs/hooks.md): code inside a Job creates further Jobs with its Job token, waits for
 * them and reads their results, instead of a pipeline definition. Children run as the parent
 * Run's creator, hang under the parent Run, and end when the parent is canceled.
 */
export class ChildJobService {
  private readonly database: Database;
  private readonly runs: RunService;
  private readonly jobs: JobService;
  private readonly jobArrays: JobArrayService;
  constructor(options: {
    database: Database;
    runs: RunService;
    jobs: JobService;
    jobArrays: JobArrayService;
  }) {
    this.database = options.database;
    this.runs = options.runs;
    this.jobs = options.jobs;
    this.jobArrays = options.jobArrays;
  }

  async create(
    principal: Principal,
    reference: JobReference,
    input: ChildJobCreateInput,
  ): Promise<ChildJobCreated> {
    const binding = principal.token?.job;
    if (
      !binding ||
      !sameId(binding.jobId, reference.jobId) ||
      !principal.token?.projectId ||
      !sameId(principal.token.projectId, reference.projectId)
    )
      throw new DomainError(403, '子Jobは親JobのJob tokenで作成します', 'driver_token_required');
    assertNoReservedRunTags(input.tags);
    return transaction(this.database, async (connection) => {
      // The Job token acts as the parent Run's creator, who must still be an editor.
      await requireProject(connection, principal, {
        projectId: reference.projectId,
        role: 'editor',
        scope: 'runs:write',
      });
      // Locking the parent orders its children's creation: limits and keys see each other.
      const parent = await findJob(connection, {
        projectId: reference.projectId,
        id: reference.jobId,
        lock: true,
      });
      if (!parent.allowChildJobs)
        throw new DomainError(403, 'このJobは子Jobを作成できません', 'child_jobs_not_allowed');
      const existing = await this.findByKey(connection, {
        projectId: reference.projectId,
        parentJobId: parent.id,
        idempotencyKey: input.idempotencyKey,
      });
      if (existing) return existing;
      if (parent.chainDepth + 1 > MAX_JOB_CHAIN_DEPTH)
        throw new DomainError(
          422,
          `Jobの連鎖は${MAX_JOB_CHAIN_DEPTH}段までです`,
          'chain_too_deep',
        );
      await this.assertWithinLimits(connection, { parentJobId: parent.id, adding: input.arraySize ?? 1 });
      const parentRun = await findRun(connection, {
        projectId: reference.projectId,
        id: parent.runId,
      });
      const placement = await first<{ hookChain: string[] }>(
        connection,
        'SELECT hook_chain FROM jobs WHERE id=$1',
        [parent.id],
      );
      const chain = { hookChain: placement!.hookChain, chainDepth: parent.chainDepth + 1 };
      const experimentId = input.experimentId ?? parentRun.experimentId;
      if (input.arraySize !== null) {
        const created = await this.jobArrays.insertArray(connection, {
          projectId: reference.projectId,
          input: {
            experimentId,
            name: input.name,
            kind: input.kind,
            codeVersionId: input.codeVersionId,
            modelVersionId: input.modelVersionId,
            inputDatasetVersionIds: input.inputDatasetVersionIds,
            parameters: input.parameters,
            tags: input.tags,
            targetId: input.targetId,
            gpuCount: input.gpuCount,
            walltimeSeconds: input.walltimeSeconds,
            size: input.arraySize,
            maxAttempts: input.maxAttempts,
            retryOnFailure: input.retryOnFailure,
            retryOnTimeout: input.retryOnTimeout,
            allowChildJobs: input.allowChildJobs,
            datasetPartitionVersionId: input.datasetPartitionVersionId,
          },
          origin: {
            createdBy: parentRun.createdBy,
            parentRunId: parentRun.id,
            placement: { parentJobId: parent.id, ...chain },
            idempotencyKey: input.idempotencyKey,
          },
        });
        return { created: true, arrayGroupId: created.arrayGroup.id, jobs: created.jobs };
      }
      const run = await this.runs.insertRun(connection, {
        projectId: reference.projectId,
        createdBy: parentRun.createdBy,
        input: {
          experimentId,
          name: input.name,
          kind: input.kind,
          parameters: input.parameters,
          tags: input.tags,
          modelVersionId: input.modelVersionId,
          codeVersionId: input.codeVersionId,
          inputDatasetVersionIds: input.inputDatasetVersionIds,
          parentRunId: parentRun.id,
          environment: {},
        },
      });
      const job = await this.jobs.insertJob(connection, {
        run,
        input: {
          runId: run.id,
          targetId: input.targetId,
          gpuIds: input.gpuIds,
          gpuCount: input.gpuCount,
          walltimeSeconds: input.walltimeSeconds,
          maxAttempts: input.maxAttempts,
          retryOnFailure: input.retryOnFailure,
          retryOnTimeout: input.retryOnTimeout,
          allowChildJobs: input.allowChildJobs,
        },
        attempt: 1,
        placement: {
          parentJobId: parent.id,
          ...chain,
          idempotencyKey: input.idempotencyKey,
        },
      });
      return { created: true, arrayGroupId: null, jobs: [job] };
    });
  }

  async list(principal: Principal, reference: JobReference): Promise<Job[]> {
    await requireProject(this.database, principal, {
      projectId: reference.projectId,
      role: 'viewer',
      scope: 'read',
    });
    const parent = await findJob(this.database, {
      projectId: reference.projectId,
      id: reference.jobId,
    });
    return rows<Job>(
      this.database,
      `SELECT ${jobColumns()} FROM jobs WHERE parent_job_id=$1
      ORDER BY created_at,array_index NULLS FIRST,attempt,id`,
      [parent.id],
    );
  }

  /** Returns once no child is queued or running, or when the wait runs out. */
  async wait(
    principal: Principal,
    reference: JobReference & { timeoutSeconds: number },
  ): Promise<ChildJobWait> {
    await requireProject(this.database, principal, {
      projectId: reference.projectId,
      role: 'viewer',
      scope: 'read',
    });
    const parent = await findJob(this.database, {
      projectId: reference.projectId,
      id: reference.jobId,
    });
    const deadline = Date.now() + reference.timeoutSeconds * 1000;
    for (;;) {
      const counts = await this.countChildren(this.database, parent.id);
      const active = counts.queued + counts.claimed + counts.running;
      if (active === 0) return { done: true, counts };
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { done: false, counts };
      await sleep(Math.min(WAIT_POLL_INTERVAL_MS, remaining));
    }
  }

  // A key names one creation: a single Job, or an array (its group carries the key).
  private async findByKey(
    connection: Connection,
    key: { projectId: string; parentJobId: string; idempotencyKey: string },
  ): Promise<ChildJobCreated | null> {
    const job = await first<Job>(
      connection,
      `SELECT ${jobColumns()} FROM jobs WHERE parent_job_id=$1 AND idempotency_key=$2`,
      [key.parentJobId, key.idempotencyKey],
    );
    if (job) return { created: false, arrayGroupId: null, jobs: [job] };
    const group = await first<{ id: string }>(
      connection,
      'SELECT id FROM job_array_groups WHERE parent_job_id=$1 AND idempotency_key=$2',
      [key.parentJobId, key.idempotencyKey],
    );
    if (!group) return null;
    const described = await this.jobArrays.describe(connection, {
      projectId: key.projectId,
      groupId: group.id,
    });
    return { created: false, arrayGroupId: group.id, jobs: described.jobs };
  }

  private async assertWithinLimits(
    connection: Connection,
    request: { parentJobId: string; adding: number },
  ): Promise<void> {
    const counted = (await first<{ total: number; active: number }>(
      connection,
      `SELECT count(*)::int AS total,count(*) FILTER(WHERE status=ANY($2::text[]))::int AS active
      FROM jobs WHERE parent_job_id=$1`,
      [request.parentJobId, ACTIVE_STATUSES],
    ))!;
    if (
      counted.total + request.adding > MAX_CHILD_JOBS_PER_PARENT ||
      counted.active + request.adding > MAX_ACTIVE_CHILD_JOBS
    )
      throw new DomainError(
        409,
        `子Jobは1つの親につき${MAX_CHILD_JOBS_PER_PARENT}件、同時に${MAX_ACTIVE_CHILD_JOBS}件までです`,
        'child_job_limit',
      );
  }

  // The current attempt of each child: a retried attempt is counted through its retry.
  private async countChildren(connection: Connection, parentJobId: string): Promise<JobStatusCounts> {
    const grouped = await rows<{ status: keyof Omit<JobStatusCounts, 'total'>; count: number }>(
      connection,
      `SELECT j.status,count(*)::int AS count FROM jobs j WHERE j.parent_job_id=$1
      AND NOT EXISTS(SELECT 1 FROM jobs retry WHERE retry.retry_of_job_id=j.id)
      GROUP BY j.status`,
      [parentJobId],
    );
    const counts: JobStatusCounts = {
      queued: 0,
      claimed: 0,
      running: 0,
      finished: 0,
      failed: 0,
      canceled: 0,
      total: 0,
    };
    for (const { status, count } of grouped) {
      counts[status] = count;
      counts.total += count;
    }
    return counts;
  }
}
