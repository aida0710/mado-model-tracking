import type { ProjectVisibility } from '@mmt/contracts';
import { Lock } from 'lucide-react';
import { text } from '../i18n/catalog';

/**
 * A Project's visibility: Private carries a lock. `iconOnly` keeps just the lock (Public then shows
 * nothing) and leaves the name to screen readers and the tooltip, for tight rows like the switcher.
 */
export function ProjectVisibilityLabel({
  visibility,
  iconOnly = false,
}: {
  visibility: ProjectVisibility;
  iconOnly?: boolean;
}) {
  const name = text[visibility];
  return (
    <span className="project-visibility" title={iconOnly ? name : undefined}>
      {visibility === 'private' && <Lock size={12} aria-hidden="true" />}
      <span className={iconOnly ? 'sr-only' : undefined}>{name}</span>
    </span>
  );
}
