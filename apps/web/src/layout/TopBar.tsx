import { Link, NavLink } from 'react-router-dom';
import { LogOut, Moon, Sun } from 'lucide-react';
import type { ProjectRole } from '@mmt/contracts';
import { authApi } from '../api/auth';
import { useAuth } from '../hooks/useAuth';
import { useTheme } from '../hooks/useTheme';
import { useMutation } from '../hooks/useMutation';
import { ErrorNotice } from '../components/Feedback';
import { canChangeOwnPassword, canManagePlugins, isGlobalAdmin } from '../lib/permissions';
import { text } from '../i18n/catalog';

const screens = [
  'experiments',
  'tasks',
  'models',
  'codes',
  'datasets',
  'lineage',
  'jobs',
  'compute',
  'plugins',
  'settings',
] as const;

export const ACCOUNT_PASSWORD_PATH = '/account/password';
export const ADMIN_PATH = '/admin';

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
  const initials = auth.user.displayName.slice(0, 2).toUpperCase();
  return (
    <>
      <a className="skip-link" href="#content">
        {text.skipContent}
      </a>
      <header className="topbar">
        <Link to="/" className="brand">
          {text.appName}
        </Link>
        <nav aria-label={text.navigation}>
          {projectId &&
            screens
              .filter(
                (screen) =>
                  screen !== 'plugins' || canManagePlugins(projectRole, isGlobalAdmin(auth.user)),
              )
              .map((screen) => (
                <NavLink key={screen} to={`/projects/${projectId}/${screen}`}>
                  {text[screen]}
                </NavLink>
              ))}
          {isGlobalAdmin(auth.user) && <NavLink to={ADMIN_PATH}>{text.administration}</NavLink>}
        </nav>
        <div className="topbar-actions">
          <button
            className="icon-button"
            onClick={theme.toggle}
            aria-label={theme.theme === 'light' ? text.darkTheme : text.lightTheme}
          >
            {theme.theme === 'light' ? <Moon size={17} /> : <Sun size={17} />}
          </button>
          {canChangeOwnPassword(auth.user) ? (
            <Link
              to={ACCOUNT_PASSWORD_PATH}
              className="avatar"
              title={`${auth.user.displayName} - ${text.changePasswordTitle}`}
              aria-label={text.changePasswordTitle}
            >
              {initials}
            </Link>
          ) : (
            <span className="avatar" title={auth.user.displayName}>
              {initials}
            </span>
          )}
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
