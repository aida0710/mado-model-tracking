import type { AuditActorType, AuditOutcome, JsonObject } from '@mmt/contracts';
import type { Connection } from '../db/database.js';

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
