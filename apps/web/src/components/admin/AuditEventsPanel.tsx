import { RefreshCw } from 'lucide-react';
import { useAuditEvents } from '../../hooks/useAuditEvents';
import { AuditEventLog } from '../AuditEventLog';
import { AdminSectionHeader } from './AdminSectionHeader';
import { text } from '../../i18n/catalog';

/**
 * The admin "audit log" section: every event, including those of no Project such as logins, user
 * administration and storage changes, which no Project's settings page shows.
 */
export function AuditEventsPanel() {
  const audit = useAuditEvents('global');
  return (
    <section className="admin-audit">
      <AdminSectionHeader
        section="audit"
        actions={
          <button className="icon-button" aria-label={text.refresh} onClick={audit.reload}>
            <RefreshCw size={17} />
          </button>
        }
      />
      <p className="muted">{text.adminAuditDescription}</p>
      <AuditEventLog audit={audit} showProject />
    </section>
  );
}
