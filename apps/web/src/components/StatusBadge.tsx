import type { JobStatus } from '@mmt/contracts';
import { text } from '../i18n/catalog';

export function StatusBadge({ status }: { status: JobStatus }) {
  return (
    <span className={`status-badge status-${status}`}>
      <span aria-hidden="true">●</span>
      {text[status]}
    </span>
  );
}
