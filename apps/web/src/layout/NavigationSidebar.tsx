import type { ReactNode } from 'react';
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { text } from '../i18n/catalog';
import type { Navigation } from '../hooks/useNavigation';
import { NavigationLinkList } from './NavigationLinkList';
import { NavigationResizeHandle } from './NavigationResizeHandle';

/**
 * The main navigation from --bp-md up: the full sidebar with names (the Project selector on top,
 * as children) or, below --bp-lg or when the user collapses it, a rail of icons. On wide screens
 * the user collapses or expands it with the button at the bottom and drags its right edge to
 * change the width. Narrower screens use NavigationDrawer instead.
 */
export function NavigationSidebar({
  navigation,
  children,
}: {
  navigation: Navigation;
  children?: ReactNode;
}) {
  const isRail = navigation.mode === 'rail';
  const toggleLabel = isRail ? text.expandNavigation : text.collapseNavigation;
  return (
    <aside className="navigation-sidebar" data-collapsed={isRail ? 'true' : 'false'}>
      <div className="navigation-sidebar-scroll">
        {!isRail && children}
        {navigation.groups.length > 0 && (
          <NavigationLinkList groups={navigation.groups} showsTitles={isRail} />
        )}
      </div>
      {navigation.canCollapse && (
        <div className="navigation-sidebar-footer">
          <button
            type="button"
            className="icon-button"
            aria-label={toggleLabel}
            aria-expanded={!isRail}
            title={toggleLabel}
            onClick={navigation.toggleCollapsed}
          >
            {isRail ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
          </button>
        </div>
      )}
      {navigation.canCollapse && !isRail && (
        <NavigationResizeHandle
          width={navigation.width}
          onResize={navigation.setWidth}
          onReset={navigation.resetWidth}
        />
      )}
    </aside>
  );
}
