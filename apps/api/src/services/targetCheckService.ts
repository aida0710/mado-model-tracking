import type { ComputeTarget, TargetCheck, WorkerTargetCheck } from '@mmt/contracts';
import type { z } from 'zod';
import type { Principal } from '../auth/principal.js';
import type { ApiConfig } from '../config.js';
import { first, rows, transaction, type Connection, type Database } from '../db/database.js';
import { DomainError, notFound } from '../domain/errors.js';
import {
  rejectOversizedResult,
  rejectSecretsInResult,
  type targetCheckClaimSchema,
  type targetCheckCompleteSchema,
} from '../domain/targetCheckValidation.js';
import { requireGlobalAdmin, requireWorker } from './accessService.js';

// Workers poll for checks every few seconds while idle; five minutes without a claim means no
// worker is in charge of the target (or none is running).
const TARGET_CHECK_QUEUE_TIMEOUT_SECONDS = 300;
// The worker's probe gives up after two minutes (target_probe.py); allow the report to arrive.
const TARGET_CHECK_CLAIM_TIMEOUT_SECONDS = 300;
// The Compute page shows recent history only.
const TARGET_CHECK_LIST_LIMIT = 20;

// lease_id and worker_token_id authorize the worker and are never returned to the Web.
const CHECK_COLUMNS =
  'id,target_id,requested_by,status,worker_id,result,failure_reason,created_at,claimed_at,finished_at';

export class TargetCheckService {
  constructor(
    private readonly database: Database,
    private readonly config: ApiConfig,
  ) {}

  async request(principal: Principal, targetId: string): Promise<TargetCheck> {
    requireGlobalAdmin(principal);
    return transaction(this.database, async (connection) => {
      const target = await this.findTarget(connection, targetId);
      // No worker connects to a site, so a check would only wait and fail as no_worker.
      if (target.executor === 'site')
        throw new DomainError(
          422,
          'siteにはtrackingから接続しないため、接続確認はできません',
          'site_check_unsupported',
        );
      await expireStaleChecks(connection);
      const created = await first<TargetCheck>(
        connection,
        `INSERT INTO target_checks(target_id,requested_by) VALUES($1,$2)
        ON CONFLICT (target_id) WHERE status IN ('queued','claimed') DO NOTHING
        RETURNING ${CHECK_COLUMNS}`,
        [targetId, principal.user.id],
      );
      if (!created)
        throw new DomainError(
          409,
          'このComputeTargetの接続確認は実行中です',
          'target_check_in_progress',
        );
      return created;
    });
  }

  async list(principal: Principal, targetId: string): Promise<TargetCheck[]> {
    requireGlobalAdmin(principal);
    return transaction(this.database, async (connection) => {
      await this.findTarget(connection, targetId);
      await expireStaleChecks(connection);
      return rows<TargetCheck>(
        connection,
        `SELECT ${CHECK_COLUMNS} FROM target_checks WHERE target_id=$1
        ORDER BY created_at DESC,id DESC LIMIT $2`,
        [targetId, TARGET_CHECK_LIST_LIMIT],
      );
    });
  }

  async claim(
    principal: Principal,
    request: z.infer<typeof targetCheckClaimSchema>,
  ): Promise<WorkerTargetCheck | null> {
    return transaction(this.database, async (connection) => {
      const worker = await requireWorker(connection, principal);
      // Serializes a worker's resent claims so one request cannot take two checks.
      await connection.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `target-check:${worker.tokenId}:${request.workerId}`,
      ]);
      await expireStaleChecks(connection);
      // A lost claim response is recovered by claiming again: the same lease comes back.
      const held = await first<{ id: string }>(
        connection,
        `SELECT id FROM target_checks WHERE status='claimed' AND worker_token_id=$1 AND worker_id=$2
        AND target_id=ANY($3::uuid[]) ORDER BY claimed_at LIMIT 1`,
        [worker.tokenId, request.workerId, request.targetIds],
      );
      const claimedId =
        held?.id ??
        (
          await first<{ id: string }>(
            connection,
            `UPDATE target_checks SET status='claimed',worker_token_id=$1,worker_id=$2,
            lease_id=gen_random_uuid(),claimed_at=now()
            WHERE id=(SELECT c.id FROM target_checks c JOIN compute_targets t ON t.id=c.target_id
              WHERE c.status='queued' AND c.target_id=ANY($3::uuid[]) AND ($4 OR t.executor<>'local')
              ORDER BY c.created_at,c.id LIMIT 1 FOR UPDATE OF c SKIP LOCKED)
            RETURNING id`,
            [worker.tokenId, request.workerId, request.targetIds, this.config.allowLocalExecutor],
          )
        )?.id;
      if (!claimedId) return null;
      const lease = (await first<{ leaseId: string; targetId: string }>(
        connection,
        'SELECT lease_id,target_id FROM target_checks WHERE id=$1',
        [claimedId],
      ))!;
      return {
        check: (await findCheck(connection, claimedId))!,
        leaseId: lease.leaseId,
        target: await this.findTarget(connection, lease.targetId),
      };
    });
  }

  async complete(
    principal: Principal,
    checkId: string,
    request: z.infer<typeof targetCheckCompleteSchema>,
  ): Promise<TargetCheck> {
    rejectOversizedResult(request.result);
    return transaction(this.database, async (connection) => {
      const worker = await requireWorker(connection, principal);
      const leased = await first<{ status: TargetCheck['status']; targetId: string }>(
        connection,
        `SELECT status,target_id FROM target_checks
        WHERE id=$1 AND worker_token_id=$2 AND lease_id=$3 FOR UPDATE`,
        [checkId, worker.tokenId, request.leaseId],
      );
      if (!leased) throw new DomainError(409, '接続確認のleaseが無効です', 'invalid_lease');
      if (leased.status !== 'claimed') {
        const finished = (await findCheck(connection, checkId))!;
        // A resent completion is safe; a timed-out check keeps its failure_reason.
        if (finished.status === request.status && finished.failureReason === null) return finished;
        throw new DomainError(409, '接続確認は既に終了しています', 'target_check_finished');
      }
      rejectSecretsInResult(request.result, await this.findTarget(connection, leased.targetId));
      return (await first<TargetCheck>(
        connection,
        `UPDATE target_checks SET status=$2,result=$3,finished_at=now() WHERE id=$1
        RETURNING ${CHECK_COLUMNS}`,
        [checkId, request.status, request.result],
      ))!;
    });
  }

  private async findTarget(connection: Connection, targetId: string): Promise<ComputeTarget> {
    const target = await first<ComputeTarget>(
      connection,
      'SELECT * FROM compute_targets WHERE id=$1',
      [targetId],
    );
    if (!target) notFound('ComputeTarget');
    return target;
  }
}

async function findCheck(connection: Connection, checkId: string): Promise<TargetCheck | undefined> {
  return first<TargetCheck>(
    connection,
    `SELECT ${CHECK_COLUMNS} FROM target_checks WHERE id=$1`,
    [checkId],
  );
}

// Ends checks nobody will finish, so a target is never stuck with an open check.
async function expireStaleChecks(connection: Connection): Promise<void> {
  await connection.query(
    `UPDATE target_checks SET status='failed',finished_at=now(),
    failure_reason=CASE WHEN status='queued' THEN 'no_worker' ELSE 'claim_timeout' END
    WHERE (status='queued' AND created_at < now()-make_interval(secs=>$1))
    OR (status='claimed' AND claimed_at < now()-make_interval(secs=>$2))`,
    [TARGET_CHECK_QUEUE_TIMEOUT_SECONDS, TARGET_CHECK_CLAIM_TIMEOUT_SECONDS],
  );
}
