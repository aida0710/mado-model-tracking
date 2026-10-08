import { Navigate, Outlet, useParams } from 'react-router-dom';
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
import { ProjectBar } from './ProjectBar';

export function AppShell() {
  const { projectId } = useParams();
  const auth = useAuth();
  const projects = useQuery('projects', administrationApi.projects);
  const userCanCreateProject = canCreateProject(auth.user);
  // A Project id from the URL that the user cannot open gets no Project navigation or alerts.
  const openProject = projects.value?.find((project) => project.id === projectId);
  return (
    <div className="app-shell">
      <TopBar projectId={openProject?.id} projectRole={openProject?.role} />
      <Resource query={projects}>
        {(items) => {
          const project = items.find((item) => item.id === projectId);
          if (!projectId && items[0])
            return <Navigate replace to={`/projects/${items[0].id}/experiments`} />;
          return (
            <>
              {items.length > 0 && <ProjectBar projects={items} project={project} />}
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
                  {projectId && <p className="notice error">{text.projectNotAccessible}</p>}
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
