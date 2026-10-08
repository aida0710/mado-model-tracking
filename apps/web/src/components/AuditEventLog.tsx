import type { AuditEventsState } from '../hooks/useAuditEvents';
import { AuditEventsTable } from './AuditEventsTable';
import { ErrorNotice, Loading } from './Feedback';

/** A paged audit log with its loading and error states, for the settings and /admin screens. */
export function AuditEventLog({
  audit,
  showProject = false,
}: {
  audit: AuditEventsState;
  showProject?: boolean;
}) {
  return (
    <>
      <ErrorNotice message={audit.error} retry={audit.reload} />
      {audit.loading && !audit.items.length ? (
        <Loading />
      ) : audit.error && !audit.items.length ? null : (
        <AuditEventsTable
          events={audit.items}
          hasMore={audit.hasMore}
          loading={audit.loading}
          onLoadMore={audit.loadMore}
          showProject={showProject}
        />
      )}
    </>
  );
}
