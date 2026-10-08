import type { JsonObject } from './index.js';

export type AuditActorType = 'user' | 'token' | 'system';
export type AuditOutcome = 'success' | 'denied' | 'failed';

export interface AuditEvent {
  id: string;
  occurredAt: string;
  actorType: AuditActorType;
  actorUserId: string | null;
  actorTokenId: string | null;
  action: string;
  outcome: AuditOutcome;
  resourceType: string;
  resourceId: string | null;
  projectId: string | null;
  details: JsonObject;
  ip: string | null;
  userAgent: string | null;
}
