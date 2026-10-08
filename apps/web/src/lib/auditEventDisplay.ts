import type { AuditEvent } from '@mmt/contracts';
import { accessText, auditActionLabels } from '../i18n/access';

/** The action in words; an action the Web has no label for yet keeps its raw name. */
export function auditActionLabel(action: string): string {
  return auditActionLabels[action] ?? action;
}

/**
 * Who acted, by display name. A token actor is marked as such. Users are never deleted, so a
 * missing name means an API that does not send `actorName`; it is still not shown as a bare UUID.
 */
export function auditActorLabel(
  event: Pick<AuditEvent, 'actorType' | 'actorUserId' | 'actorName'>,
): string {
  if (event.actorType === 'system') return accessText.auditActorSystem;
  const name = event.actorName ?? (event.actorUserId ? accessText.auditActorUnknown : '—');
  return event.actorType === 'token' ? `${name} (${accessText.auditActorToken})` : name;
}

/** The Project of the event in the global log; authentication and user events have none. */
export function auditProjectLabel(event: Pick<AuditEvent, 'projectId' | 'projectName'>): string {
  if (event.projectId === null) return accessText.auditProjectNone;
  return event.projectName ?? event.projectId;
}
