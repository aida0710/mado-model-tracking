import { RefreshCw } from 'lucide-react';
import { useAuditEvents } from '../../hooks/useAuditEvents';
import { AuditEventLog } from '../AuditEventLog';
import { text } from '../../i18n/catalog';

/**
 * The admin "audit log" tab: every event, including those of no Project such as logins, user
 * administration and storage changes, which no Project's settings page shows.
 */
export function AuditEventsPanel() {
  const audit = useAuditEvents('global');
  return (
    <section className="admin-audit">
      <div className="section-heading">
        <h2>{text.auditEvents}</h2>
        <button className="icon-button" aria-label={text.refresh} onClick={audit.reload}>
          <RefreshCw size={17} />
        </button>
      </div>
      <p className="muted">{text.adminAuditDescription}</p>
      <AuditEventLog audit={audit} showProject />
    </section>
  );
}
