import type { ReactNode } from 'react';
import type { NavigationGroup } from './navigationLinks';
import { NavigationLinkList } from './NavigationLinkList';

/**
 * The main navigation on wide screens: a column on the left with the Project selector on top
 * (children) and the grouped screen links below. Narrower screens use NavigationDrawer instead.
 */
export function NavigationSidebar({
  groups,
  children,
}: {
  groups: NavigationGroup[];
  children?: ReactNode;
}) {
  return (
    <aside className="navigation-sidebar">
      {children}
      {groups.length > 0 && <NavigationLinkList groups={groups} />}
    </aside>
  );
}
