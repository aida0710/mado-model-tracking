import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { transaction, type Database } from '../db/database.js';

/** Outbox tables that share the claim/lease/backoff columns. */
export type LeasedOutboxTable = 'plugin_outbox' | 'notification_outbox';

export interface LeasedOutboxPolicy {
  table: LeasedOutboxTable;
  /** Longer than the sender's HTTP deadline so another dispatcher cannot send concurrently. */
  leaseSeconds: number;
  firstRetrySeconds: number;
  maxRetrySeconds: number;
  /** After this many failed attempts the row becomes 'failed'. Unset retries forever. */
  maxAttempts?: number;
  /** Stored as last_error when the sender throws something other than OutboxDeliveryError. */
  defaultErrorCode: string;
}

export interface OutboxRow {
  id: string;
  /** Attempts already made before this claim, as stored. */
  attempts: number;
}

/** A claimed row. attempt counts this attempt (1 for the first). */
export type Lease<Row extends OutboxRow> = Row & { deliveryId: string; attempt: number };

/**
 * A sender failure with a code that is safe to store: never a remote response or a URL.
 * permanent skips the remaining attempts, for failures a retry cannot fix.
 */
export class OutboxDeliveryError extends Error {
  constructor(
    readonly code: string,
    readonly options: { permanent?: boolean } = {},
  ) {
    super(code);
    this.name = 'OutboxDeliveryError';
  }
}

/** Columns a delivered row stores besides the status, such as the receiver-facing delivery id. */
export interface DeliveryReceipt {
  columns?: Readonly<Record<string, string>>;
}

const COLUMN_NAME = /^[a-z_]+$/;
// Caps the exponent so the doubling stays within the integer range before the maxRetry cap.
const MAX_BACKOFF_EXPONENT = 10;

/**
 * Selects rows that are due, or whose sending lease has expired. `alias` is the outbox table's
 * alias and `leaseParameter` the SQL parameter holding the lease seconds.
 */
export function claimableCondition(alias: string, leaseParameter: string): string {
  return `((${alias}.status='pending' AND ${alias}.next_attempt_at<=now()) OR (${alias}.status='sending' AND ${alias}.locked_at<now()-make_interval(secs=>${leaseParameter})))`;
}

export function retryDelaySeconds(policy: LeasedOutboxPolicy, attempt: number): number {
  return Math.min(
    policy.maxRetrySeconds,
    policy.firstRetrySeconds * 2 ** Math.min(attempt - 1, MAX_BACKOFF_EXPONENT),
  );
}

/**
 * Claim → send → record for outbox tables, shared by plugin events and notifications.
 * A claim marks the row 'sending' with a fresh delivery id inside a transaction that selected it
 * with FOR UPDATE SKIP LOCKED; results are written only while that delivery id still holds, so a
 * dispatcher whose lease expired cannot overwrite the attempt that took over.
 */
export class LeasedOutbox {
  constructor(
    private readonly database: Database,
    private readonly policy: LeasedOutboxPolicy,
  ) {}

  /**
   * Sends up to `limit` rows one by one. `select` runs in the claim transaction and must lock the
   * row it returns (FOR UPDATE … SKIP LOCKED, using claimableCondition). Returns delivered count.
   */
  async dispatchBatch<Row extends OutboxRow>(request: {
    limit: number;
    select: (connection: PoolClient, leaseSeconds: number) => Promise<Row | undefined>;
    send: (lease: Lease<Row>) => Promise<DeliveryReceipt | void>;
  }): Promise<number> {
    let delivered = 0;
    for (let index = 0; index < request.limit; index++) {
      const lease = await this.claim(request.select);
      if (!lease) break;
      try {
        const receipt = await request.send(lease);
        await this.markDelivered(lease, receipt ?? {});
        delivered++;
      } catch (error) {
        await this.markFailedAttempt(lease, error);
      }
    }
    return delivered;
  }

  private async claim<Row extends OutboxRow>(
    select: (connection: PoolClient, leaseSeconds: number) => Promise<Row | undefined>,
  ): Promise<Lease<Row> | null> {
    return transaction(this.database, async (connection) => {
      const row = await select(connection, this.policy.leaseSeconds);
      if (!row) return null;
      const deliveryId = randomUUID();
      await connection.query(
        `UPDATE ${this.policy.table} SET status='sending',delivery_id=$2,locked_at=now(),attempts=attempts+1 WHERE id=$1`,
        [row.id, deliveryId],
      );
      return { ...row, deliveryId, attempt: row.attempts + 1 };
    });
  }

  private async markDelivered(
    lease: { id: string; deliveryId: string },
    receipt: DeliveryReceipt,
  ): Promise<void> {
    const extra = Object.entries(receipt.columns ?? {});
    if (extra.some(([column]) => !COLUMN_NAME.test(column)))
      throw new Error('Invalid outbox receipt column');
    const assignments = extra.map(([column], index) => `,${column}=$${index + 3}`).join('');
    await this.database.query(
      `UPDATE ${this.policy.table} SET status='delivered',delivered_at=now(),last_error=NULL,delivery_id=NULL,locked_at=NULL${assignments} WHERE id=$1 AND delivery_id=$2`,
      [lease.id, lease.deliveryId, ...extra.map(([, value]) => value)],
    );
  }

  private async markFailedAttempt(
    lease: { id: string; deliveryId: string; attempt: number },
    error: unknown,
  ): Promise<void> {
    // Persist a safe failure code, never the remote service's response or credential-bearing URL.
    const isKnown = error instanceof OutboxDeliveryError;
    const code = isKnown ? error.code : this.policy.defaultErrorCode;
    const { maxAttempts } = this.policy;
    const isFinal =
      (isKnown && error.options.permanent === true) ||
      (maxAttempts !== undefined && lease.attempt >= maxAttempts);
    if (isFinal) {
      await this.database.query(
        `UPDATE ${this.policy.table} SET status='failed',last_error=$3,delivery_id=NULL,locked_at=NULL WHERE id=$1 AND delivery_id=$2`,
        [lease.id, lease.deliveryId, code],
      );
      return;
    }
    await this.database.query(
      `UPDATE ${this.policy.table} SET status='pending',next_attempt_at=now()+make_interval(secs=>$3),last_error=$4,delivery_id=NULL,locked_at=NULL WHERE id=$1 AND delivery_id=$2`,
      [lease.id, lease.deliveryId, retryDelaySeconds(this.policy, lease.attempt), code],
    );
  }
}
