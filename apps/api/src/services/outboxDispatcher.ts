import type { PluginConnection, PluginEvent } from '@mmt/contracts';
import { first, type Database } from '../db/database.js';
import { claimableCondition, LeasedOutbox } from './leasedOutbox.js';
import { PollingLoop } from './pollingLoop.js';
import type { PluginService } from './pluginService.js';

// The lease exceeds the platform HTTP deadline so another dispatcher cannot send concurrently.
const DELIVERY_LEASE_SECONDS = 60;
const FIRST_RETRY_SECONDS = 5;
const MAX_RETRY_SECONDS = 3600;
const IDLE_POLL_MS = 1000;
const DISPATCH_BATCH_SIZE = 20;

interface PluginDelivery {
  id: string;
  event: PluginEvent;
  attempts: number;
  pluginId: string;
  baseUrl: string;
  tokenEnv: string;
}

/** Sends plugin_outbox events to each Project's plugin connections. Retries without a limit. */
export class OutboxDispatcher {
  private readonly outbox: LeasedOutbox;
  private readonly loop: PollingLoop;

  constructor(
    database: Database,
    private readonly plugins: PluginService,
  ) {
    this.outbox = new LeasedOutbox(database, {
      table: 'plugin_outbox',
      leaseSeconds: DELIVERY_LEASE_SECONDS,
      firstRetrySeconds: FIRST_RETRY_SECONDS,
      maxRetrySeconds: MAX_RETRY_SECONDS,
      defaultErrorCode: 'plugin_delivery_failed',
    });
    this.loop = new PollingLoop({
      intervalMs: IDLE_POLL_MS,
      run: () => this.dispatchBatch(),
      failureEvent: 'outbox_dispatch_failed',
    });
  }

  start(): void {
    this.loop.start();
  }

  stop(): Promise<void> {
    return this.loop.stop();
  }

  dispatchBatch(limit = DISPATCH_BATCH_SIZE): Promise<number> {
    return this.outbox.dispatchBatch<PluginDelivery>({
      limit,
      select: async (connection, leaseSeconds) => {
        const delivery = await first<Omit<PluginDelivery, 'baseUrl' | 'tokenEnv'>>(
          connection,
          `SELECT o.id,o.event,o.attempts,o.plugin_id FROM plugin_outbox o JOIN plugin_connections p ON p.id=o.plugin_id
          WHERE p.enabled AND ${claimableCondition('o', '$1')}
          ORDER BY o.created_at LIMIT 1 FOR UPDATE OF o SKIP LOCKED`,
          [leaseSeconds],
        );
        if (!delivery) return undefined;
        // Serialize the claim with plugin edits; already claimed HTTP calls can finish.
        const plugin = await first<PluginConnection>(
          connection,
          'SELECT * FROM plugin_connections WHERE id=$1 AND enabled FOR SHARE SKIP LOCKED',
          [delivery.pluginId],
        );
        if (!plugin) return undefined;
        return { ...delivery, baseUrl: plugin.baseUrl, tokenEnv: plugin.tokenEnv };
      },
      send: async (delivery) => {
        await this.plugins.client(delivery).sendEvent(delivery.event);
      },
    });
  }
}
