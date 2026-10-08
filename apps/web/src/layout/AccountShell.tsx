import { Outlet } from 'react-router-dom';
import { TopBar } from './TopBar';

/** Layout for screens that belong to no Project: the signed-in user's account and /admin. */
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
