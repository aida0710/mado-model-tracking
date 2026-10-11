import type { ComputeTargetVisibility, ProjectVisibility } from '@mmt/contracts';
import { Lock } from 'lucide-react';
import { text } from '../i18n/catalog';

/**
 * Public or Private, as Projects and computers have it: Private carries a lock. `iconOnly` keeps
 * just the lock (Public then shows nothing) and leaves the name to screen readers and the tooltip,
 * for tight rows like the Project switcher.
 */
export function VisibilityLabel({
  visibility,
  iconOnly = false,
}: {
  visibility: ProjectVisibility | ComputeTargetVisibility;
  iconOnly?: boolean;
}) {
  const name = text[visibility];
  return (
    <span className="visibility-label" title={iconOnly ? name : undefined}>
      {visibility === 'private' && <Lock size={12} aria-hidden="true" />}
      <span className={iconOnly ? 'sr-only' : undefined}>{name}</span>
    </span>
  );
}
