import { Outlet } from 'react-router-dom';
import { TopBar } from './TopBar';

/** Layout for screens about the signed-in user, which belong to no Project. */
export function AccountShell() {
  return (
    <div className="app-shell">
      <TopBar />
      <main id="content" className="page">
        <Outlet />
      </main>
    </div>
  );
}
