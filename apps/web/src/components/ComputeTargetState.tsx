import { text } from '../i18n/catalog';

/**
 * Whether a computer takes new Jobs, with how its launcher stands when it is an automatic site
 * (lib/computeTargetOverview.launcherStatusLabel).
 */
export function ComputeTargetState({
  enabled,
  launcherStatus = null,
}: {
  enabled: boolean;
  launcherStatus?: string | null;
}) {
  return (
    <span className="badge-group">
      <span className={`status-badge ${enabled ? 'status-finished' : 'status-queued'}`}>
        {enabled ? text.computerEnabled : text.computerDisabled}
      </span>
      {launcherStatus && <span className="muted">{launcherStatus}</span>}
    </span>
  );
}
