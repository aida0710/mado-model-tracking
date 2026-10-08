import { Navigate, Outlet, useNavigate, useParams } from 'react-router-dom';
import { administrationApi } from '../api/administration';
import { useAuth } from '../hooks/useAuth';
import { useQuery } from '../hooks/useQuery';
import { ProjectContext } from '../hooks/useProject';
import { Resource } from '../components/Feedback';
import { PageHeader } from '../components/PageHeader';
import { ProjectList } from '../components/ProjectList';
import { canCreateProject } from '../lib/permissions';
import { text } from '../i18n/catalog';
import { TopBar } from './TopBar';

export function AppShell() {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const auth = useAuth();
  const projects = useQuery('projects', administrationApi.projects);
  const userCanCreateProject = canCreateProject(auth.user);
  return (
    <div className="app-shell">
      <TopBar
        projectId={projectId}
        projectRole={projects.value?.find((project) => project.id === projectId)?.role}
      />
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
