import { randomUUID } from 'node:crypto';
import type {
  NotificationEvent,
  NotificationEventType,
  NotificationRuleFilter,
  NotificationRunSummary,
  RunKind,
} from '@mmt/contracts';
import { first, rows, type Connection } from '../db/database.js';

/**
 * What a rule filter is matched against. isAutomation is asked only when a matching rule has
 * automationOnly, because finding the automation behind a Run takes extra queries.
 */
export interface NotificationSubject {
  runKind?: RunKind;
  experimentId?: string;
  isAutomation?: () => Promise<boolean>;
}

/** The message part of an event, built only when at least one rule will receive it. */
export interface NotificationEventDescription {
  title: string;
  run: NotificationRunSummary | null;
  details?: NotificationEvent['details'];
  url: string | null;
  occurredAt?: string;
}

export interface NotificationEventSource {
  projectId: string;
  type: NotificationEventType;
  /** Identifies the occurrence, such as `run.failed:<run id>`; repeating it queues nothing new. */
  dedupeKey: string;
  subject: NotificationSubject;
  describe: () => Promise<NotificationEventDescription>;
}

interface SubscribedRule {
  id: string;
  channelId: string;
  filter: NotificationRuleFilter;
}

export async function matchesNotificationFilter(
  filter: NotificationRuleFilter,
  subject: NotificationSubject,
): Promise<boolean> {
  if (filter.runKinds && (!subject.runKind || !filter.runKinds.includes(subject.runKind)))
    return false;
  if (
    filter.experimentIds &&
    (!subject.experimentId || !filter.experimentIds.includes(subject.experimentId))
  )
    return false;
  if (filter.automationOnly && !(await subject.isAutomation?.())) return false;
  return true;
}

/**
 * Queues one outbox row per enabled rule of the Project that subscribes to the event and whose
 * filter matches, using the caller's connection so the rows commit or roll back with the change
 * that caused the event. Rules whose channel is disabled receive nothing. Returns rows added.
 * Monitoring and automation features call this for their own event types.
 */
export async function enqueueNotificationEvent(
  connection: Connection,
  source: NotificationEventSource,
): Promise<number> {
  const subscribed = await rows<SubscribedRule>(
    connection,
    `SELECT r.id,r.channel_id,r.filter FROM notification_rules r
    JOIN notification_channels c ON c.id=r.channel_id
    WHERE r.project_id=$1 AND r.enabled AND c.enabled AND $2=ANY(r.event_types)
      AND (c.project_id IS NULL OR c.project_id=r.project_id)
    ORDER BY r.created_at,r.id`,
    [source.projectId, source.type],
  );
  const matched: SubscribedRule[] = [];
  for (const rule of subscribed)
    if (await matchesNotificationFilter(rule.filter, source.subject)) matched.push(rule);
  if (!matched.length) return 0;
  const event = await buildEvent(connection, source);
  let added = 0;
  for (const rule of matched) {
    const inserted = await connection.query(
      `INSERT INTO notification_outbox(project_id,rule_id,channel_id,event_id,event_type,dedupe_key,event)
      VALUES($1,$2,$3,$4,$5,$6,$7::jsonb) ON CONFLICT (rule_id,dedupe_key) DO NOTHING`,
      [
        source.projectId,
        rule.id,
        rule.channelId,
        event.id,
        source.type,
        source.dedupeKey,
        JSON.stringify(event),
      ],
    );
    added += inserted.rowCount ?? 0;
  }
  return added;
}

// Every rule receives the same immutable payload and event id, so receivers can deduplicate.
async function buildEvent(
  connection: Connection,
  source: NotificationEventSource,
): Promise<NotificationEvent> {
  const description = await source.describe();
  const project = await first<{ id: string; name: string }>(
    connection,
    'SELECT id,name FROM projects WHERE id=$1',
    [source.projectId],
  );
  return {
    schemaVersion: 1,
    id: randomUUID(),
    type: source.type,
    occurredAt: description.occurredAt ?? new Date().toISOString(),
    title: description.title,
    project: project ?? null,
    run: description.run,
    details: description.details ?? {},
    url: description.url,
  };
}
