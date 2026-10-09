import { Link } from 'react-router-dom';
import { LogOut, Moon, Sun } from 'lucide-react';
import type { ProjectRole } from '@mmt/contracts';
import { authApi } from '../api/auth';
import { useAuth } from '../hooks/useAuth';
import { useTheme } from '../hooks/useTheme';
import { useMutation } from '../hooks/useMutation';
import { ErrorNotice } from '../components/Feedback';
import { isGlobalAdmin } from '../lib/permissions';
import { narrowerThan } from '../lib/breakpoints';
import { useMediaQuery } from '../lib/useMediaQuery';
import { UserMenu } from '../components/UserMenu';
import { OperationsAlertBadge } from '../components/OperationsAlertBadge';
import { text } from '../i18n/catalog';
import { navigationLinks } from './navigationLinks';
import { NavigationDrawer } from './NavigationDrawer';
import { NavigationLinkList } from './NavigationLinkList';

export { ACCOUNT_PATH, ACCOUNT_PASSWORD_PATH } from '../components/UserMenu';
export { ADMIN_PATH } from './navigationLinks';

// Below --bp-lg the fourteen Project screens no longer fit beside the brand and actions, so the
// navigation moves into the drawer.
const DRAWER_NAVIGATION_QUERY = narrowerThan('lg');

/** The header: screen navigation for the open Project, theme, the signed-in user and logout. */
export function TopBar({
  projectId,
  projectRole,
}: {
  projectId?: string;
  projectRole?: ProjectRole;
}) {
  const auth = useAuth();
  const theme = useTheme();
  const mutation = useMutation();
  const usesDrawer = useMediaQuery(DRAWER_NAVIGATION_QUERY);
  const links = navigationLinks({ projectId, projectRole, isGlobalAdmin: isGlobalAdmin(auth.user) });
  return (
    <>
      <a className="skip-link" href="#content">
        {text.skipContent}
      </a>
      <header className="topbar">
        {usesDrawer && links.length > 0 && <NavigationDrawer links={links} />}
        <Link to="/" className="brand">
          {text.appName}
        </Link>
        {!usesDrawer && <NavigationLinkList links={links} />}
        <div className="topbar-actions">
          {projectId && <OperationsAlertBadge projectId={projectId} />}
          <button
            className="icon-button"
            onClick={theme.toggle}
            aria-label={theme.theme === 'light' ? text.darkTheme : text.lightTheme}
          >
            {theme.theme === 'light' ? <Moon size={17} /> : <Sun size={17} />}
          </button>
          <UserMenu />
          <button
            className="icon-button"
            disabled={mutation.pending}
            aria-label={text.logout}
            onClick={() =>
              void mutation.run(async () => {
                await authApi.logout();
                auth.reload();
              })
            }
          >
            <LogOut size={17} />
          </button>
        </div>
      </header>
      <ErrorNotice message={mutation.error} />
    </>
  );
}
