import { randomUUID } from 'node:crypto';
import type { PluginEvent } from '@mmt/contracts';
import { first, transaction, type Database } from '../db/database.js';
import type { PluginService } from './pluginService.js';

// The lease exceeds the platform HTTP deadline so another dispatcher cannot send concurrently.
const DELIVERY_LEASE_SECONDS = 60;
const FIRST_RETRY_SECONDS = 5;
const MAX_RETRY_SECONDS = 3600;
const IDLE_POLL_MS = 1000;
const DISPATCH_BATCH_SIZE = 20;

interface Delivery {
  id: string;
  deliveryId: string;
  baseUrl: string;
  tokenEnv: string;
  event: PluginEvent;
  attempts: number;
}

export class OutboxDispatcher {
  private isStopped = true;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private active: Promise<number> | undefined;
  constructor(
    private readonly database: Database,
    private readonly plugins: PluginService,
  ) {}

  start(): void {
    if (!this.isStopped) return;
    this.isStopped = false;
    this.schedule();
  }

  async stop(): Promise<void> {
    this.isStopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.active?.catch(() => undefined);
  }

  async dispatchBatch(limit = DISPATCH_BATCH_SIZE): Promise<number> {
    let dispatched = 0;
    for (let index = 0; index < limit; index++) {
      const delivery = await this.claimDelivery();
      if (!delivery) break;
      try {
        await this.plugins.client(delivery).sendEvent(delivery.event);
        await this.database.query(
          "UPDATE plugin_outbox SET status='delivered',delivered_at=now(),last_error=NULL,delivery_id=NULL,locked_at=NULL WHERE id=$1 AND delivery_id=$2",
          [delivery.id, delivery.deliveryId],
        );
        dispatched++;
      } catch {
        // Persist a safe failure code, never the remote service's response or credential-bearing URL.
        const retrySeconds = Math.min(
          MAX_RETRY_SECONDS,
          FIRST_RETRY_SECONDS * 2 ** Math.min(delivery.attempts, 10),
        );
        await this.database.query(
          "UPDATE plugin_outbox SET status='pending',next_attempt_at=now()+make_interval(secs=>$3),last_error='plugin_delivery_failed',delivery_id=NULL,locked_at=NULL WHERE id=$1 AND delivery_id=$2",
          [delivery.id, delivery.deliveryId, retrySeconds],
        );
      }
    }
    return dispatched;
  }

  private async claimDelivery(): Promise<Delivery | null> {
    return transaction(this.database, async (connection) => {
      const delivery = await first<Omit<Delivery, 'deliveryId'>>(
        connection,
        `SELECT o.id,o.event,o.attempts,p.base_url,p.token_env FROM plugin_outbox o JOIN plugin_connections p ON p.id=o.plugin_id
        WHERE p.enabled AND ((o.status='pending' AND o.next_attempt_at<=now()) OR (o.status='sending' AND o.locked_at<now()-make_interval(secs=>$1)))
        ORDER BY o.created_at LIMIT 1 FOR UPDATE OF o SKIP LOCKED`,
        [DELIVERY_LEASE_SECONDS],
      );
      if (!delivery) return null;
      const deliveryId = randomUUID();
      await connection.query(
        "UPDATE plugin_outbox SET status='sending',delivery_id=$2,locked_at=now(),attempts=attempts+1 WHERE id=$1",
        [delivery.id, deliveryId],
      );
      return { ...delivery, deliveryId };
    });
  }

  private schedule(): void {
    if (this.isStopped) return;
    this.timer = setTimeout(() => {
      this.active = this.dispatchBatch();
      void this.active
        .catch(() => console.error(JSON.stringify({ event: 'outbox_dispatch_failed' })))
        .finally(() => {
          this.active = undefined;
          this.schedule();
        });
    }, IDLE_POLL_MS);
    this.timer.unref();
  }
}
