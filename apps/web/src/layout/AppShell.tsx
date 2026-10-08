import { Link, Navigate, NavLink, Outlet, useNavigate, useParams } from 'react-router-dom';
import { LogOut, Moon, Sun } from 'lucide-react';
import { administrationApi } from '../api/administration';
import { authApi } from '../api/auth';
import { useAuth } from '../hooks/useAuth';
import { useTheme } from '../hooks/useTheme';
import { useQuery } from '../hooks/useQuery';
import { useMutation } from '../hooks/useMutation';
import { ProjectContext } from '../hooks/useProject';
import { ErrorNotice, Resource } from '../components/Feedback';
import { PageHeader } from '../components/PageHeader';
import { ProjectList } from '../components/ProjectList';
import { canCreateProject, canManagePlugins, isGlobalAdmin } from '../lib/permissions';
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

export function AppShell() {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const auth = useAuth();
  const theme = useTheme();
  const projects = useQuery('projects', administrationApi.projects);
  const mutation = useMutation();
  const userCanCreateProject = canCreateProject(auth.user);
  return (
    <div className="app-shell">
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
                  screen !== 'plugins' ||
                  canManagePlugins(
                    projects.value?.find((project) => project.id === projectId)?.role,
                    isGlobalAdmin(auth.user),
                  ),
              )
              .map((screen) => (
                <NavLink key={screen} to={`/projects/${projectId}/${screen}`}>
                  {text[screen]}
                </NavLink>
              ))}
        </nav>
        <div className="topbar-actions">
          <button
            className="icon-button"
            onClick={theme.toggle}
            aria-label={theme.theme === 'light' ? text.darkTheme : text.lightTheme}
          >
            {theme.theme === 'light' ? <Moon size={17} /> : <Sun size={17} />}
          </button>
          <span className="avatar" title={auth.user.displayName}>
            {auth.user.displayName.slice(0, 2).toUpperCase()}
          </span>
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
      <Resource query={projects}>
        {(items) => {
          const project = items.find((item) => item.id === projectId);
          if (!projectId && items[0])
            return <Navigate replace to={`/projects/${items[0].id}/experiments`} />;
          return (
            <>
              <div className="projectbar">
                <label>
                  <span>{text.project}</span>
                  <select
                    aria-label={text.project}
                    value={project?.id ?? ''}
                    onChange={(event) => navigate(`/projects/${event.target.value}/experiments`)}
                  >
                    {!project && <option value="">{text.none}</option>}
                    {items.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                  </select>
                </label>
                <span className="project-role">{project ? text[project.role] : ''}</span>
              </div>
              {project ? (
                <ProjectContext.Provider
                  value={{ project, projects: items, reloadProjects: projects.reload }}
                >
                  <main id="content" className="workspace" key={project.id}>
                    <Outlet />
                  </main>
                </ProjectContext.Provider>
              ) : (
                <main id="content" className="page">
                  <PageHeader title={text.settings} />
                  {items.length === 0 && (
                    <>
                      <p className="muted">{text.noProjects}</p>
                      <p className="muted">
                        {userCanCreateProject ? text.noProjectsCreateHint : text.noProjectsAskAdmin}
                      </p>
                    </>
                  )}
                  {(items.length > 0 || userCanCreateProject) && (
                    <ProjectList projects={items} onCreated={projects.reload} />
                  )}
                </main>
              )}
            </>
          );
        }}
      </Resource>
    </div>
  );
}
