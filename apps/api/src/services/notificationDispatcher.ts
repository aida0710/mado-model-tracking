import type { NotificationChannelKind, NotificationEvent } from '@mmt/contracts';
import {
  NotificationSendError,
  resolveNotificationDestination,
  type NotificationSenders,
} from '@mmt/platform';
import { first, type Database } from '../db/database.js';
import { claimableCondition, LeasedOutbox, OutboxDeliveryError } from './leasedOutbox.js';
import { PollingLoop } from './pollingLoop.js';

// Old notifications lose their value; after 8 attempts (about 10 minutes of backoff) give up.
export const NOTIFICATION_MAX_ATTEMPTS = 8;
// The lease exceeds the 5-second send deadline so another dispatcher cannot send concurrently.
const DELIVERY_LEASE_SECONDS = 60;
const FIRST_RETRY_SECONDS = 5;
const MAX_RETRY_SECONDS = 3600;
const IDLE_POLL_MS = 1000;
const DISPATCH_BATCH_SIZE = 20;

interface NotificationDeliveryRow {
  id: string;
  attempts: number;
  event: NotificationEvent;
  channelKind: NotificationChannelKind;
  channelName: string;
  urlEnv: string | null;
  secretEnv: string | null;
  recipients: string[];
  channelEnabled: boolean;
  ruleEnabled: boolean;
}

/**
 * Sends notification_outbox rows through the sender of each channel kind. Rows of a channel or
 * rule disabled after queuing fail without sending, so re-enabling does not flush stale alerts.
 */
export class NotificationDispatcher {
  private readonly outbox: LeasedOutbox;
  private readonly loop: PollingLoop;

  constructor(
    database: Database,
    private readonly options: { senders: NotificationSenders; environment: NodeJS.ProcessEnv },
  ) {
    this.outbox = new LeasedOutbox(database, {
      table: 'notification_outbox',
      leaseSeconds: DELIVERY_LEASE_SECONDS,
      firstRetrySeconds: FIRST_RETRY_SECONDS,
      maxRetrySeconds: MAX_RETRY_SECONDS,
      maxAttempts: NOTIFICATION_MAX_ATTEMPTS,
      defaultErrorCode: 'notification_delivery_failed',
    });
    this.loop = new PollingLoop({
      intervalMs: IDLE_POLL_MS,
      run: () => this.dispatchBatch(),
      failureEvent: 'notification_dispatch_failed',
    });
  }

  start(): void {
    this.loop.start();
  }

  stop(): Promise<void> {
    return this.loop.stop();
  }

  dispatchBatch(limit = DISPATCH_BATCH_SIZE): Promise<number> {
    return this.outbox.dispatchBatch<NotificationDeliveryRow>({
      limit,
      select: (connection, leaseSeconds) =>
        first<NotificationDeliveryRow>(
          connection,
          `SELECT o.id,o.attempts,o.event,c.kind AS channel_kind,c.name AS channel_name,c.url_env,
            c.secret_env,c.recipients,c.enabled AS channel_enabled,r.enabled AS rule_enabled
          FROM notification_outbox o
          JOIN notification_channels c ON c.id=o.channel_id
          JOIN notification_rules r ON r.id=o.rule_id
          WHERE ${claimableCondition('o', '$1')}
          ORDER BY o.next_attempt_at,o.created_at LIMIT 1 FOR UPDATE OF o SKIP LOCKED`,
          [leaseSeconds],
        ),
      send: async (delivery) => {
        const { deliveryId } = await this.send(delivery);
        return { columns: { sent_delivery_id: deliveryId } };
      },
    });
  }

  private async send(delivery: NotificationDeliveryRow): Promise<{ deliveryId: string }> {
    if (!delivery.channelEnabled)
      throw new OutboxDeliveryError('notification_channel_disabled', { permanent: true });
    if (!delivery.ruleEnabled)
      throw new OutboxDeliveryError('notification_rule_disabled', { permanent: true });
    const sender = this.options.senders[delivery.channelKind];
    // Email is stored and matched before an SMTP sender exists; retrying cannot deliver it.
    if (!sender)
      throw new OutboxDeliveryError(`${delivery.channelKind}_sender_unavailable`, {
        permanent: true,
      });
    try {
      const destination = resolveNotificationDestination(
        {
          kind: delivery.channelKind,
          name: delivery.channelName,
          urlEnv: delivery.urlEnv,
          secretEnv: delivery.secretEnv,
          recipients: delivery.recipients,
        },
        this.options.environment,
      );
      return await sender.send(destination, delivery.event);
    } catch (error) {
      if (error instanceof NotificationSendError) throw new OutboxDeliveryError(error.code);
      throw error;
    }
  }
}
