import { Link } from 'react-router-dom';
import { LogOut, Moon, Sun } from 'lucide-react';
import { authApi } from '../api/auth';
import { useAuth } from '../hooks/useAuth';
import { useTheme } from '../hooks/useTheme';
import { useMutation } from '../hooks/useMutation';
import type { Navigation } from '../hooks/useNavigation';
import { ErrorNotice } from '../components/Feedback';
import { UserMenu } from '../components/UserMenu';
import { OperationsAlertBadge } from '../components/OperationsAlertBadge';
import { text } from '../i18n/catalog';
import { NavigationDrawer } from './NavigationDrawer';

export { ACCOUNT_PATH, ACCOUNT_PASSWORD_PATH } from '../components/UserMenu';
export { ADMIN_PATH } from './navigationLinks';

/**
 * The header: the app name, theme, the signed-in user and logout. The screen navigation sits in
 * the sidebar or the rail; below --bp-md this header opens it in the drawer.
 */
export function TopBar({ projectId, navigation }: { projectId?: string; navigation: Navigation }) {
  const auth = useAuth();
  const theme = useTheme();
  const mutation = useMutation();
  return (
    <>
      <a className="skip-link" href="#content">
        {text.skipContent}
      </a>
      <header className="topbar">
        {navigation.mode === 'drawer' && navigation.groups.length > 0 && (
          <NavigationDrawer groups={navigation.groups} />
        )}
        <Link to="/" className="brand">
          {text.appName}
        </Link>
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
