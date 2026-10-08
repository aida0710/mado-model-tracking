import { useEffect, useId, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Bell } from 'lucide-react';
import { useOperationsAlerts } from '../hooks/useOperationsAlerts';
import { describeOperationsAlertSubject } from '../lib/operationsAlertSubject';
import { formatDate } from '../lib/format';
import { operationsAlertKindLabels } from '../i18n/operations';
import { text, textTemplates } from '../i18n/catalog';

/** The header bell: open operations alerts of the Project, listed in a popover on click. */
export function OperationsAlertBadge({ projectId }: { projectId: string }) {
  const alerts = useOperationsAlerts(projectId);
  const location = useLocation();
  const popoverId = useId();
  const container = useRef<HTMLDivElement>(null);
  const [isOpen, setIsOpen] = useState(false);
  const items = alerts.value ?? [];
  const label = items.length ? textTemplates.operationsAlertCount(items.length) : text.operationsAlerts;

  useEffect(() => setIsOpen(false), [location.pathname]);
  useEffect(() => {
    if (!isOpen) return;
    const closeOutside = (event: PointerEvent) => {
      if (!container.current?.contains(event.target as Node)) setIsOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setIsOpen(false);
    };
    document.addEventListener('pointerdown', closeOutside);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOutside);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [isOpen]);

  return (
    <div className="operations-alerts" ref={container}>
      <button
        type="button"
        className={`icon-button operations-alert-button${items.length ? ' has-alerts' : ''}`}
        aria-label={label}
        title={label}
        aria-expanded={isOpen}
        aria-controls={popoverId}
        onClick={() => setIsOpen((open) => !open)}
      >
        <Bell size={17} />
        {items.length > 0 && <span className="operations-alert-count">{items.length}</span>}
      </button>
      {isOpen && (
        <div className="operations-alert-popover" id={popoverId} role="dialog" aria-label={label}>
          <strong className="operations-alert-heading">{text.operationsAlerts}</strong>
          {alerts.error && <p className="notice error">{text.operationsAlertsLoadFailed}</p>}
          {!alerts.error && items.length === 0 && (
            <p className="muted operations-alert-empty">
              {alerts.loading ? text.loading : text.operationsAlertsNone}
            </p>
          )}
          {items.length > 0 && (
            <ul>
              {items.map((alert) => {
                const subject = describeOperationsAlertSubject(alert);
                return (
                  <li key={alert.id}>
                    <Link to={`/projects/${encodeURIComponent(projectId)}/${subject.pagePath}`}>
                      <span className="operations-alert-kind">
                        {operationsAlertKindLabels[alert.kind]}
                      </span>
                      <span className="operations-alert-subject">{subject.label}</span>
                      <span className="muted operations-alert-time">
                        {text.operationsAlertOpenedAt}: {formatDate(alert.openedAt)}
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
