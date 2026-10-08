import type { AuditEvent } from '@mmt/contracts';
import { DataTable } from './DataTable';
import { summarizeAuditDetails } from '../lib/auditEventSummary';
import { formatDate, formatValue } from '../lib/format';
import { accessText } from '../i18n/access';

// Keys the parent adds to i18n/access.ts when merging; listed in the coordination plan.
type AuditTextKey =
  | 'auditEvents'
  | 'auditOccurredAt'
  | 'auditActor'
  | 'auditAction'
  | 'auditOutcome'
  | 'auditResource'
  | 'auditDetails'
  | 'auditEmpty'
  | 'auditLoadMore'
  | 'auditActorToken'
  | 'auditActorSystem'
  | 'auditOutcomeSuccess'
  | 'auditOutcomeDenied'
  | 'auditOutcomeFailed'
  | 'auditActionProjectMemberSet'
  | 'auditActionTokenCreate'
  | 'auditActionTokenRevoke';

// Until the catalog has these keys the key name is shown, as agreed for wave 1.
export const auditText = (key: AuditTextKey): string =>
  (accessText as Partial<Record<AuditTextKey, string>>)[key] ?? key;

const actionTextKeys: Record<string, AuditTextKey> = {
  'project.member.set': 'auditActionProjectMemberSet',
  'token.create': 'auditActionTokenCreate',
  'token.revoke': 'auditActionTokenRevoke',
};

const outcomeTextKeys: Record<AuditEvent['outcome'], AuditTextKey> = {
  success: 'auditOutcomeSuccess',
  denied: 'auditOutcomeDenied',
  failed: 'auditOutcomeFailed',
};

// Actions recorded by other packages keep their raw name until they get a label.
const actionLabel = (action: string) => {
  const key = actionTextKeys[action];
  return key ? auditText(key) : action;
};

function actorLabel(event: AuditEvent): string {
  if (event.actorType === 'system') return auditText('auditActorSystem');
  const user = formatValue(event.actorUserId);
  return event.actorType === 'token' ? `${user} (${auditText('auditActorToken')})` : user;
}

export function AuditEventsTable({
  events,
  hasMore,
  loading,
  onLoadMore,
}: {
  events: AuditEvent[];
  hasMore: boolean;
  loading: boolean;
  onLoadMore: () => void;
}) {
  return (
    <>
      <DataTable
        items={events}
        rowKey={(event) => event.id}
        empty={auditText('auditEmpty')}
        columns={[
          {
            key: 'occurredAt',
            label: auditText('auditOccurredAt'),
            render: (event) => formatDate(event.occurredAt),
          },
          {
            key: 'actor',
            label: auditText('auditActor'),
            className: 'mono',
            render: actorLabel,
          },
          {
            key: 'action',
            label: auditText('auditAction'),
            render: (event) => <span title={event.action}>{actionLabel(event.action)}</span>,
          },
          {
            key: 'outcome',
            label: auditText('auditOutcome'),
            render: (event) => auditText(outcomeTextKeys[event.outcome]),
          },
          {
            key: 'resource',
            label: auditText('auditResource'),
            className: 'mono',
            render: (event) =>
              event.resourceId ? `${event.resourceType}/${event.resourceId}` : event.resourceType,
          },
          {
            key: 'details',
            label: auditText('auditDetails'),
            render: (event) => (
              <span title={JSON.stringify(event.details)}>
                {summarizeAuditDetails(event.details)}
              </span>
            ),
          },
        ]}
      />
      {hasMore && (
        <div className="section-actions">
          <button className="button small" disabled={loading} onClick={onLoadMore}>
            {auditText('auditLoadMore')}
          </button>
        </div>
      )}
    </>
  );
}
