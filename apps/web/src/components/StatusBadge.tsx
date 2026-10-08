import type { JobStatus } from '@mmt/contracts';
import { text } from '../i18n/catalog';

/** `label` replaces the status name when the caller knows more, such as an early-stopped trial. */
export function StatusBadge({ status, label }: { status: JobStatus; label?: string }) {
  return (
    <span className={`status-badge status-${status}`}>
      <span aria-hidden="true">●</span>
      {label ?? text[status]}
    </span>
  );
}
