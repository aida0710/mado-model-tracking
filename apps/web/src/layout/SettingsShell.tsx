import type { CSSProperties } from 'react';
import { Outlet } from 'react-router-dom';
import { useNavigation } from '../hooks/useNavigation';
import { NavigationSidebar } from './NavigationSidebar';
import { TopBar } from './TopBar';

/**
 * Layout for 全体設定 (/settings/<section>), the screens that belong to no Project. Its navigation
 * holds only the 全体設定 group and, for global administrators, 全体管理.
 */
export function SettingsShell() {
  const navigation = useNavigation();
  return (
    <div
      className="app-shell"
      data-navigation={navigation.mode}
      style={{ '--navigation-width': `${navigation.width}px` } as CSSProperties}
    >
      <TopBar navigation={navigation} />
      <div className="app-body">
        {navigation.mode !== 'drawer' && <NavigationSidebar navigation={navigation} />}
        <main id="content" className="page app-content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
