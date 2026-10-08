import type { AuditEvent } from '@mmt/contracts';
import { DataTable } from './DataTable';
import { summarizeAuditDetails } from '../lib/auditEventSummary';
import { formatDate, formatValue } from '../lib/format';
import { accessText } from '../i18n/access';

type AuditTextKey = keyof typeof accessText;

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
  return key ? accessText[key] : action;
};

function actorLabel(event: AuditEvent): string {
  if (event.actorType === 'system') return accessText.auditActorSystem;
  const user = formatValue(event.actorUserId);
  return event.actorType === 'token' ? `${user} (${accessText.auditActorToken})` : user;
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
        empty={accessText.auditEmpty}
        columns={[
          {
            key: 'occurredAt',
            label: accessText.auditOccurredAt,
            render: (event) => formatDate(event.occurredAt),
          },
          {
            key: 'actor',
            label: accessText.auditActor,
            className: 'mono',
            render: actorLabel,
          },
          {
            key: 'action',
            label: accessText.auditAction,
            render: (event) => <span title={event.action}>{actionLabel(event.action)}</span>,
          },
          {
            key: 'outcome',
            label: accessText.auditOutcome,
            render: (event) => accessText[outcomeTextKeys[event.outcome]],
          },
          {
            key: 'resource',
            label: accessText.auditResource,
            className: 'mono',
            render: (event) =>
              event.resourceId ? `${event.resourceType}/${event.resourceId}` : event.resourceType,
          },
          {
            key: 'details',
            label: accessText.auditDetails,
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
            {accessText.auditLoadMore}
          </button>
        </div>
      )}
    </>
  );
}
