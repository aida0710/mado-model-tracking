import type { AuditEvent } from '@mmt/contracts';
import { ResponsiveTable } from './ResponsiveTable';
import { summarizeAuditDetails } from '../lib/auditEventSummary';
import { auditActionLabel, auditActorLabel, auditProjectLabel } from '../lib/auditEventDisplay';
import { formatDate } from '../lib/format';
import { accessText } from '../i18n/access';

const outcomeLabels: Record<AuditEvent['outcome'], string> = {
  success: accessText.auditOutcomeSuccess,
  denied: accessText.auditOutcomeDenied,
  failed: accessText.auditOutcomeFailed,
};

/** Audit events, newest first. `showProject` adds the Project column for the global log. */
export function AuditEventsTable({
  events,
  hasMore,
  loading,
  onLoadMore,
  showProject = false,
}: {
  events: AuditEvent[];
  hasMore: boolean;
  loading: boolean;
  onLoadMore: () => void;
  showProject?: boolean;
}) {
  return (
    <>
      <ResponsiveTable
        rows={events}
        rowKey={(event) => event.id}
        empty={accessText.auditEmpty}
        columns={[
          {
            key: 'occurredAt',
            priority: 'primary',
            header: accessText.auditOccurredAt,
            render: (event) => formatDate(event.occurredAt),
          },
          ...(showProject
            ? [
                {
                  key: 'project',
                  priority: 'secondary' as const,
                  header: accessText.auditProject,
                  className: 'audit-label',
                  render: (event: AuditEvent) => auditProjectLabel(event),
                },
              ]
            : []),
          {
            key: 'actor',
            priority: 'primary',
            header: accessText.auditActor,
            className: 'audit-label',
            render: (event) => (
              <span title={event.actorUserId ?? undefined}>{auditActorLabel(event)}</span>
            ),
          },
          {
            key: 'action',
            priority: 'primary',
            header: accessText.auditAction,
            className: 'audit-label',
            render: (event) => <span title={event.action}>{auditActionLabel(event.action)}</span>,
          },
          {
            key: 'outcome',
            priority: 'secondary',
            header: accessText.auditOutcome,
            className: 'audit-label',
            render: (event) => outcomeLabels[event.outcome],
          },
          {
            key: 'resource',
            priority: 'secondary',
            header: accessText.auditResource,
            className: 'mono',
            render: (event) =>
              event.resourceId ? `${event.resourceType}/${event.resourceId}` : event.resourceType,
          },
          {
            key: 'details',
            priority: 'secondary',
            header: accessText.auditDetails,
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
