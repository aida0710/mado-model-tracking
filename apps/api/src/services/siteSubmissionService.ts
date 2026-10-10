import type {
  ComputeTarget,
  Job,
  JobPhase,
  ManualSiteConfiguration,
  ManualSubmissionWaiting,
  SiteSchedulerCancellation,
  SiteSubmission,
  SiteSubmissionAccount,
  SiteSubmissionMode,
  SiteSubmissionRequester,
} from '@mmt/contracts';
import type { Principal } from '../auth/principal.js';
import { first, rows, transaction, type Connection, type Database } from '../db/database.js';
import { DomainError } from '../domain/errors.js';
import type { SiteSubmissionResultInput } from '../domain/siteExecutionValidation.js';
import { jobColumns } from '../repositories/jobRepository.js';
import { findCurrentJobShell } from '../repositories/siteJobShellRepository.js';
import { findSiteSettings } from '../repositories/siteSettingsRepository.js';
import { requireScope } from './accessService.js';
import type { JobService } from './jobService.js';
import { requireLauncher } from './launcherService.js';
import type { RunCompletionService } from './runCompletionService.js';
import { findSiteTarget, requireTargetUser } from './siteAccess.js';
import { failUnstartedSiteJob, submissionCountSql } from './siteJobEnding.js';
import { resolveSubmissionAccount } from './siteReadiness.js';

// Who holds claimed submissions: a launcher, or the requester with their own API token. A report
// must come from the same holder: the same ID, with any token of the same owner (a launcher whose
// token was replaced still reports what it submitted).
interface SubmissionHolder {
  tokenId: string;
  holderId: string;
}

interface ClaimScope {
  holder: SubmissionHolder;
  mode: SiteSubmissionMode;
  // A person's token may be limited to one Project; a launcher's spans every Project.
  projectId: string | null;
  targetIds: string[] | null;
  // A launcher claims only the sites assigned to it.
  launcherId: string | null;
  // Manual submissions take the requester's own Runs in Projects where they edit, unless the
  // owner of the computer takes all of them.
  requesterId: string | null;
  // Whoever runs the job shell of a manual submission; their settings apply.
  submittingUserId: string | null;
  limit: number;
}

// The tokens of the holder's owner, in SQL; $token is the request's token.
const HOLDER_TOKENS_SQL = (token: string) =>
  `(SELECT o.id FROM api_tokens o WHERE o.user_id=(SELECT t.user_id FROM api_tokens t WHERE t.id=${token}))`;

// The Job `j` is on an automatic site that the launcher $launcher submits for now, in SQL.
const ASSIGNED_SITE_SQL = (launcher: string) =>
  `EXISTS(SELECT 1 FROM compute_targets t JOIN site_settings s ON s.target_id=t.id
    WHERE t.id=j.target_id AND t.submission_mode='automatic' AND s.launcher_id=${launcher})`;

const SUBMISSION_SAVEPOINT = 'site_submission';
// Cancellations one launcher request returns; the launcher asks again for the rest.
const CANCELLATION_LIST_LIMIT = 1000;
const TERMINAL_STATUSES = ['finished', 'failed', 'canceled'];

function invalidSubmission(message: string): never {
  throw new DomainError(409, message, 'invalid_submission');
}

// A manual submission is the requester's own act on a site, so it needs their own API token: a
// browser session cannot run `mado-tracking submit`, and a Job token is the Job's, not theirs.
function requireSubmitterToken(principal: Principal, scope: string): { tokenId: string } {
  if (principal.method !== 'token' || !principal.token || principal.token.job)
    throw new DomainError(403, '本人のAPI tokenが必要です', 'api_token_required');
  requireScope(principal, scope);
  return { tokenId: principal.token.id };
}

/**
 * Hands site Jobs to whoever submits them (docs/sites.md). A claim moves queued Jobs to
 * claimed/submitting and issues their Job tokens; the report records what the site's job shell
 * did. The Run stays queued until its runner starts the container.
 */
export class SiteSubmissionService {
  private readonly database: Database;
  private readonly jobs: JobService;
  private readonly runCompletion: RunCompletionService;
  constructor(options: { database: Database; jobs: JobService; runCompletion: RunCompletionService }) {
    this.database = options.database;
    this.jobs = options.jobs;
    this.runCompletion = options.runCompletion;
  }

  async claim(
    principal: Principal,
    request: { targetIds?: string[]; limit: number },
  ): Promise<SiteSubmission[]> {
    return transaction(this.database, async (connection) => {
      const launcher = await requireLauncher(connection, principal);
      const holder = { tokenId: launcher.tokenId, holderId: launcher.launcherId };
      await this.lockHolder(connection, holder);
      await connection.query('UPDATE launchers SET last_seen_at=now() WHERE id=$1', [launcher.launcherId]);
      return this.claimSubmissions(connection, {
        holder,
        mode: 'automatic',
        projectId: null,
        targetIds: request.targetIds ?? null,
        launcherId: launcher.launcherId,
        requesterId: null,
        submittingUserId: null,
        limit: request.limit,
      });
    });
  }

  async report(
    principal: Principal,
    request: { results: SiteSubmissionResultInput[] },
  ): Promise<Job[]> {
    return transaction(this.database, async (connection) => {
      const launcher = await requireLauncher(connection, principal);
      return this.applyResults(connection, {
        holder: { tokenId: launcher.tokenId, holderId: launcher.launcherId },
        results: request.results,
      });
    });
  }

  /**
   * Jobs that ended while still in the scheduler queue of a site this launcher submits for now,
   * whichever launcher queued them: after a site moves to another launcher, the new one logs in
   * with its own key and removes them.
   */
  async cancellations(
    principal: Principal,
    request: { targetIds?: string[] },
  ): Promise<SiteSchedulerCancellation[]> {
    return transaction(this.database, async (connection) => {
      const launcher = await requireLauncher(connection, principal);
      const pending = await rows<{ jobId: string; targetId: string; schedulerJobId: string; requesterId: string }>(
        connection,
        `SELECT j.id AS job_id,j.target_id,j.scheduler_job_id,r.created_by AS requester_id
        FROM jobs j JOIN runs r ON r.id=j.run_id AND r.project_id=j.project_id
        WHERE ${ASSIGNED_SITE_SQL('$1')}
        AND j.scheduler_cancel_state='pending' AND ($2::uuid[] IS NULL OR j.target_id=ANY($2::uuid[]))
        ORDER BY j.ended_at,j.id LIMIT $3`,
        [launcher.launcherId, request.targetIds ?? null, CANCELLATION_LIST_LIMIT],
      );
      const cancellations: SiteSchedulerCancellation[] = [];
      for (const { requesterId, ...job } of pending)
        cancellations.push({
          ...job,
          account: await this.cancellationAccount(connection, { targetId: job.targetId, requesterId }),
        });
      return cancellations;
    });
  }

  async reportCancellations(
    principal: Principal,
    request: { jobIds: string[] },
  ): Promise<void> {
    await transaction(this.database, async (connection) => {
      const launcher = await requireLauncher(connection, principal);
      await connection.query(
        `UPDATE jobs j SET scheduler_cancel_state='done'
        WHERE j.id=ANY($1::uuid[]) AND ${ASSIGNED_SITE_SQL('$2')} AND j.scheduler_cancel_state='pending'`,
        [request.jobIds, launcher.launcherId],
      );
    });
  }

  /**
   * Manual sites with Jobs waiting for `mado-tracking submit`: one's own Jobs, and every waiting
   * Job of the computers one owns (what `--all` takes).
   */
  async listManual(principal: Principal): Promise<ManualSubmissionWaiting[]> {
    requireSubmitterToken(principal, 'read');
    return rows<ManualSubmissionWaiting>(
      this.database,
      `SELECT t.id AS target_id,t.name AS target_name,
        (count(*) FILTER (WHERE r.created_by=$1 AND EXISTS(SELECT 1 FROM effective_project_roles e
          WHERE e.project_id=j.project_id AND e.user_id=$1 AND e.role IN ('editor','admin'))))::int AS waiting_jobs,
        CASE WHEN t.owner_user_id=$1 THEN count(*)::int END AS all_waiting_jobs
      FROM jobs j JOIN compute_targets t ON t.id=j.target_id
      JOIN runs r ON r.id=j.run_id AND r.project_id=j.project_id
      WHERE j.status='queued' AND j.phase='waiting_manual' AND (r.created_by=$1 OR t.owner_user_id=$1)
      AND ($2::uuid IS NULL OR j.project_id=$2)
      GROUP BY t.id,t.name,t.owner_user_id
      HAVING t.owner_user_id=$1 OR count(*) FILTER (WHERE r.created_by=$1 AND EXISTS(
        SELECT 1 FROM effective_project_roles e
        WHERE e.project_id=j.project_id AND e.user_id=$1 AND e.role IN ('editor','admin'))) > 0
      ORDER BY t.name`,
      [principal.user.id, principal.token?.projectId ?? null],
    );
  }

  /** What `mado-tracking submit` needs before it claims: settings, job shell, one's account. */
  async manualConfiguration(principal: Principal, targetId: string): Promise<ManualSiteConfiguration> {
    requireSubmitterToken(principal, 'read');
    return transaction(this.database, async (connection) => {
      const target = await this.manualTarget(connection, targetId);
      await requireTargetUser(connection, principal, target);
      const settings = (await findSiteSettings(connection, targetId))!;
      return {
        target,
        settings,
        jobShell: (await findCurrentJobShell(connection, targetId)) ?? null,
        account: await resolveSubmissionAccount(connection, {
          target,
          settings,
          requesterId: principal.user.id,
          submittingUserId: principal.user.id,
        }),
      };
    });
  }

  async claimManual(
    principal: Principal,
    request: { targetId: string; submitterId: string; limit: number; all: boolean },
  ): Promise<SiteSubmission[]> {
    const { tokenId } = requireSubmitterToken(principal, 'jobs:write');
    return transaction(this.database, async (connection) => {
      const target = await this.manualTarget(connection, request.targetId);
      if (request.all && target.ownerUserId !== principal.user.id)
        throw new DomainError(
          403,
          '全員のJobを投入できるのは、この計算機の所有者だけです',
          'site_owner_required',
        );
      const holder = { tokenId, holderId: request.submitterId };
      await this.lockHolder(connection, holder);
      return this.claimSubmissions(connection, {
        holder,
        mode: 'manual',
        projectId: principal.token?.projectId ?? null,
        targetIds: [request.targetId],
        launcherId: null,
        requesterId: request.all ? null : principal.user.id,
        submittingUserId: principal.user.id,
        limit: request.limit,
      });
    });
  }

  async reportManual(
    principal: Principal,
    request: { submitterId: string; results: SiteSubmissionResultInput[] },
  ): Promise<Job[]> {
    const { tokenId } = requireSubmitterToken(principal, 'jobs:write');
    return transaction(this.database, async (connection) =>
      this.applyResults(connection, {
        holder: { tokenId, holderId: request.submitterId },
        results: request.results,
      }),
    );
  }

  private async manualTarget(connection: Connection, targetId: string): Promise<ComputeTarget> {
    const target = await findSiteTarget(connection, targetId);
    if (target.submissionMode !== 'manual')
      throw new DomainError(
        422,
        'このsiteはlauncherが投入します（手動投入のsiteではありません）',
        'site_not_manual',
      );
    return target;
  }

  // The account that queued a Job, which its cancel command runs as; best effort, since the
  // person's settings may have changed since (the launcher then leaves the Job in the queue).
  private async cancellationAccount(
    connection: Connection,
    job: { targetId: string; requesterId: string },
  ): Promise<SiteSubmissionAccount> {
    const target = await findSiteTarget(connection, job.targetId);
    const settings = (await findSiteSettings(connection, job.targetId))!;
    try {
      return await resolveSubmissionAccount(connection, {
        target,
        settings,
        requesterId: job.requesterId,
        submittingUserId: null,
      });
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      return {
        mode: settings.accountMode,
        accountName: '',
        workDirectory: settings.workDirectory,
        variables: settings.variables,
        keyId: null,
      };
    }
  }

  // Serializes a holder's duplicate HTTP requests, while other holders can use SKIP LOCKED.
  private async lockHolder(connection: Connection, holder: SubmissionHolder): Promise<void> {
    await connection.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      `site:${holder.tokenId}:${holder.holderId}`,
    ]);
  }

  private async claimSubmissions(
    connection: Connection,
    scope: ClaimScope,
  ): Promise<SiteSubmission[]> {
    const waitingPhase: JobPhase | null = scope.mode === 'manual' ? 'waiting_manual' : null;
    const submissions: SiteSubmission[] = [];
    const seen: string[] = [];
    // Targets that are at their limit, or that another claim is filling right now.
    const unavailableTargets: string[] = [];
    while (submissions.length < scope.limit) {
      const candidate = await first<Job>(
        connection,
        `SELECT ${jobColumns('j')} FROM jobs j JOIN compute_targets t ON t.id=j.target_id
        JOIN runs r ON r.id=j.run_id AND r.project_id=j.project_id
        WHERE j.status='queued' AND j.phase IS NOT DISTINCT FROM $1::text
        AND t.executor='site' AND t.submission_mode=$2 AND t.enabled
        AND ($3::uuid IS NULL OR j.project_id=$3) AND ($4::uuid[] IS NULL OR j.target_id=ANY($4::uuid[]))
        AND ($5::uuid IS NULL OR (r.created_by=$5 AND EXISTS(SELECT 1 FROM effective_project_roles e
          WHERE e.project_id=j.project_id AND e.user_id=$5 AND e.role IN ('editor','admin'))))
        AND NOT(j.id=ANY($6::uuid[])) AND NOT(j.target_id=ANY($7::uuid[]))
        AND ($8::uuid IS NULL OR EXISTS(SELECT 1 FROM site_settings s
          WHERE s.target_id=j.target_id AND s.launcher_id=$8))
        ORDER BY j.created_at,j.array_index NULLS FIRST,j.id LIMIT 1 FOR UPDATE OF j SKIP LOCKED`,
        [
          waitingPhase,
          scope.mode,
          scope.projectId,
          scope.targetIds,
          scope.requesterId,
          seen,
          unavailableTargets,
          scope.launcherId,
        ],
      );
      if (!candidate) break;
      const target = await this.reserveTargetCapacity(connection, candidate.targetId);
      if (!target) {
        unavailableTargets.push(candidate.targetId);
        continue;
      }
      const members =
        target.supportsArray && candidate.arrayGroupId
          ? await rows<Job>(
              connection,
              `SELECT ${jobColumns()} FROM jobs WHERE array_group_id=$1 AND target_id=$2 AND status='queued'
              AND phase IS NOT DISTINCT FROM $3::text ORDER BY array_index,id FOR UPDATE SKIP LOCKED`,
              [candidate.arrayGroupId, target.id, waitingPhase],
            )
          : [candidate];
      seen.push(...members.map((job) => job.id));
      const submission = await this.submit(connection, {
        target,
        members,
        holder: scope.holder,
        submittingUserId: scope.submittingUserId,
      });
      if (submission) submissions.push(submission);
    }
    return submissions;
  }

  /**
   * Locks the site while its Jobs are claimed and checks its limit. maxConcurrentJobs counts
   * submissions on a site (an array is one where the site takes arrays), since the scheduler,
   * not tracking, places them.
   */
  private async reserveTargetCapacity(
    connection: Connection,
    targetId: string,
  ): Promise<ComputeTarget | undefined> {
    const target = await first<ComputeTarget>(
      connection,
      'SELECT * FROM compute_targets WHERE id=$1 AND enabled=true FOR UPDATE SKIP LOCKED',
      [targetId],
    );
    if (!target) return undefined;
    const occupancy = (await first<{ count: number }>(
      connection,
      `SELECT ${submissionCountSql('$2')} AS count FROM jobs
      WHERE target_id=$1 AND status IN ('claimed','running')`,
      [target.id, target.supportsArray],
    ))!;
    return occupancy.count < target.maxConcurrentJobs ? target : undefined;
  }

  // A Job that cannot be described to the site (for example a deleted checkpoint, or a requester
  // without an account on it) fails instead of blocking the queue on every claim.
  private async submit(
    connection: Connection,
    submission: {
      target: ComputeTarget;
      members: Job[];
      holder: SubmissionHolder;
      submittingUserId: string | null;
    },
  ): Promise<SiteSubmission | null> {
    const { target, members, holder } = submission;
    await connection.query(`SAVEPOINT ${SUBMISSION_SAVEPOINT}`);
    try {
      const settings = await findSiteSettings(connection, target.id);
      const jobShell = settings ? await findCurrentJobShell(connection, target.id) : undefined;
      if (!settings || !jobShell)
        throw new DomainError(422, 'この計算機にはjob shellがありません', 'site_submission_unready');
      const requester = (await first<SiteSubmissionRequester>(
        connection,
        'SELECT u.id,u.email,u.username FROM runs r JOIN users u ON u.id=r.created_by WHERE r.id=$1',
        [members[0]!.runId],
      ))!;
      const account = await resolveSubmissionAccount(connection, {
        target,
        settings,
        requesterId: requester.id,
        submittingUserId: submission.submittingUserId,
      });
      const claimed = await rows<Job>(
        connection,
        `UPDATE jobs SET status='claimed',phase='submitting',worker_id=$2,lease_id=gen_random_uuid(),
          worker_token_id=$3,heartbeat_at=now(),site_job_shell_id=$4
        WHERE id=ANY($1::uuid[]) RETURNING ${jobColumns()}`,
        [members.map((job) => job.id), holder.holderId, holder.tokenId, jobShell.id],
      );
      claimed.sort((left, right) => (left.arrayIndex ?? 0) - (right.arrayIndex ?? 0));
      const workerJobs = [];
      for (const job of claimed) workerJobs.push(await this.jobs.getWorkerJob(connection, job));
      await connection.query(`RELEASE SAVEPOINT ${SUBMISSION_SAVEPOINT}`);
      return {
        target,
        arrayGroupId: claimed[0]!.arrayGroupId,
        requester,
        jobs: workerJobs,
        settings,
        jobShell,
        account,
      };
    } catch (error) {
      await connection.query(`ROLLBACK TO SAVEPOINT ${SUBMISSION_SAVEPOINT}`);
      if (!(error instanceof DomainError)) throw error;
      for (const job of members)
        await failUnstartedSiteJob(connection, this.runCompletion, {
          job,
          endReason: 'submit_failed',
          error: error.message,
        });
      return null;
    }
  }

  private async applyResults(
    connection: Connection,
    report: { holder: SubmissionHolder; results: SiteSubmissionResultInput[] },
  ): Promise<Job[]> {
    const { holder } = report;
    const reported: Job[] = [];
    for (const result of report.results) {
      const jobs = await rows<Job>(
        connection,
        `SELECT ${jobColumns()} FROM jobs WHERE id=ANY($1::uuid[])
        AND worker_token_id IN ${HOLDER_TOKENS_SQL('$2')} AND worker_id=$3
        ORDER BY array_index NULLS FIRST,id FOR UPDATE`,
        [result.jobIds, holder.tokenId, holder.holderId],
      );
      if (jobs.length !== result.jobIds.length)
        invalidSubmission('このlauncher（submit）が受け取ったJobではありません');
      for (const job of jobs)
        reported.push(
          result.outcome === 'submitted'
            ? await this.recordSubmitted(connection, { job, schedulerJobId: result.schedulerJobId ?? null })
            : await this.recordFailed(connection, { job, error: result.error ?? null }),
        );
    }
    return reported;
  }

  private async recordSubmitted(
    connection: Connection,
    submitted: { job: Job; schedulerJobId: string | null },
  ): Promise<Job> {
    const { job, schedulerJobId } = submitted;
    if (job.status === 'claimed' && job.phase === 'submitting')
      return (await first<Job>(
        connection,
        `UPDATE jobs SET phase='submitted',scheduler_job_id=$2,submitted_at=now(),heartbeat_at=now()
        WHERE id=$1 RETURNING ${jobColumns()}`,
        [job.id, schedulerJobId],
      ))!;
    // A resend, a direct host whose runner reported before the job shell returned, or a Job that
    // ended first: only the scheduler ID is filled in. A Job that ended before its runner started
    // still has a scheduler job in the queue, which the launcher then removes.
    return (await first<Job>(
      connection,
      `UPDATE jobs SET scheduler_job_id=COALESCE(scheduler_job_id,$2),submitted_at=COALESCE(submitted_at,now()),
        scheduler_cancel_state=CASE
          WHEN status=ANY($3::text[]) AND runner_instance_id IS NULL AND scheduler_cancel_state IS NULL
            AND COALESCE(scheduler_job_id,$2) IS NOT NULL THEN 'pending'
          ELSE scheduler_cancel_state END
      WHERE id=$1 RETURNING ${jobColumns()}`,
      [job.id, schedulerJobId, TERMINAL_STATUSES],
    ))!;
  }

  private async recordFailed(
    connection: Connection,
    failed: { job: Job; error: string | null },
  ): Promise<Job> {
    const { job } = failed;
    if (job.status === 'claimed' && job.phase === 'submitting')
      return failUnstartedSiteJob(connection, this.runCompletion, {
        job,
        endReason: 'submit_failed',
        error: failed.error ?? 'siteのjob shellが投入に失敗しました',
      });
    if (job.status === 'claimed' && job.phase === 'submitted')
      invalidSubmission('投入済みと報告されたJobを失敗にはできません');
    // A resend, or a Job that already ended or whose runner reports for itself.
    return job;
  }
}
