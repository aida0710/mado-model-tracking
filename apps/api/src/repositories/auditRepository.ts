import type { AuditActorType, AuditEvent, AuditOutcome, JsonObject } from '@mmt/contracts';
import { first, rows, type Connection } from '../db/database.js';

export interface AuditEventInput {
  actorType: AuditActorType;
  actorUserId?: string | null;
  actorTokenId?: string | null;
  action: string;
  outcome: AuditOutcome;
  resourceType: string;
  resourceId?: string | null;
  projectId?: string | null;
  details?: JsonObject;
  ip?: string | null;
  userAgent?: string | null;
}

// Callers pass the business transaction's connection so the audit row commits or rolls back with it.
export async function writeAuditEvent(
  connection: Connection,
  event: AuditEventInput,
): Promise<void> {
  await connection.query(
    `INSERT INTO audit_events(actor_type,actor_user_id,actor_token_id,action,outcome,resource_type,
    resource_id,project_id,details,ip,user_agent) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11)`,
    [
      event.actorType,
      event.actorUserId ?? null,
      event.actorTokenId ?? null,
      event.action,
      event.outcome,
      event.resourceType,
      event.resourceId ?? null,
      event.projectId ?? null,
      JSON.stringify(event.details ?? {}),
      event.ip ?? null,
      event.userAgent ?? null,
    ],
  );
}

export interface AuditEventFilter {
  projectId?: string;
  action?: string;
  actorUserId?: string;
  outcome?: AuditOutcome;
  // ID of the last event on the previous page; the page continues strictly after it.
  cursor?: string;
  limit: number;
}

const auditEventColumns = `id,occurred_at,actor_type,actor_user_id,actor_token_id,action,outcome,
  resource_type,resource_id,project_id,details,ip,user_agent`;

// Keyset pagination on (occurred_at,id) stays stable while new events are appended.
export async function listAuditEvents(
  connection: Connection,
  filter: AuditEventFilter,
): Promise<AuditEvent[]> {
  return rows<AuditEvent>(
    connection,
    `SELECT ${auditEventColumns} FROM audit_events
    WHERE ($1::uuid IS NULL OR project_id=$1) AND ($2::text IS NULL OR action=$2)
      AND ($3::uuid IS NULL OR actor_user_id=$3) AND ($4::text IS NULL OR outcome=$4)
      AND ($5::uuid IS NULL OR (occurred_at,id) < (SELECT occurred_at,id FROM audit_events WHERE id=$5))
    ORDER BY occurred_at DESC,id DESC LIMIT $6`,
    [
      filter.projectId ?? null,
      filter.action ?? null,
      filter.actorUserId ?? null,
      filter.outcome ?? null,
      filter.cursor ?? null,
      filter.limit,
    ],
  );
}

// A Project listing accepts only its own events as a cursor so IDs from other Projects are not probed.
export async function auditCursorExists(
  connection: Connection,
  cursor: { id: string; projectId?: string },
): Promise<boolean> {
  return Boolean(
    await first(
      connection,
      'SELECT id FROM audit_events WHERE id=$1 AND ($2::uuid IS NULL OR project_id=$2)',
      [cursor.id, cursor.projectId ?? null],
    ),
  );
}
