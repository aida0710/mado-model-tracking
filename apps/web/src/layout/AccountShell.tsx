import type { CSSProperties } from 'react';
import { Outlet } from 'react-router-dom';
import { useNavigation } from '../hooks/useNavigation';
import { NavigationSidebar } from './NavigationSidebar';
import { TopBar } from './TopBar';

/** Layout for screens that belong to no Project: the signed-in user's account and /admin. */
export function AccountShell() {
  const navigation = useNavigation();
  return (
    <div
      className="app-shell"
      data-navigation={navigation.mode}
      style={{ '--navigation-width': `${navigation.width}px` } as CSSProperties}
    >
      <TopBar navigation={navigation} />
      <div className="app-body">
        {navigation.mode !== 'drawer' && navigation.groups.length > 0 && (
          <NavigationSidebar navigation={navigation} />
        )}
        <main id="content" className="page app-content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
