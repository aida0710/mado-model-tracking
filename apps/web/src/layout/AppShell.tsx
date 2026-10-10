import { Navigate, Outlet, useParams } from 'react-router-dom';
import { administrationApi } from '../api/administration';
import { useAuth } from '../hooks/useAuth';
import { useQuery } from '../hooks/useQuery';
import { ProjectContext } from '../hooks/useProject';
import { useNavigation } from '../hooks/useNavigation';
import { Resource } from '../components/Feedback';
import { PageHeader } from '../components/PageHeader';
import { ProjectList } from '../components/ProjectList';
import { canCreateProject } from '../lib/permissions';
import { text } from '../i18n/catalog';
import { TopBar } from './TopBar';
import { ProjectBar } from './ProjectBar';
import { NavigationSidebar } from './NavigationSidebar';

export function AppShell() {
  const { projectId } = useParams();
  const auth = useAuth();
  const projects = useQuery('projects', administrationApi.projects);
  const userCanCreateProject = canCreateProject(auth.user);
  // A Project id from the URL that the user cannot open gets no Project navigation or alerts.
  const openProject = projects.value?.find((project) => project.id === projectId);
  const navigation = useNavigation(openProject?.id, openProject?.role);
  // The Project selector heads the sidebar on wide screens and sits under the header otherwise.
  const projectPicker = projects.value?.length ? (
    <ProjectBar
      projects={projects.value}
      project={openProject}
      placement={navigation.usesDrawer ? 'bar' : 'sidebar'}
    />
  ) : null;
  return (
    <div className="app-shell">
      <TopBar projectId={openProject?.id} navigation={navigation} />
      <div className="app-body">
        {!navigation.usesDrawer && (projectPicker || navigation.groups.length > 0) && (
          <NavigationSidebar groups={navigation.groups}>{projectPicker}</NavigationSidebar>
        )}
        <div className="app-content">
          {navigation.usesDrawer && projectPicker}
          <Resource query={projects}>
            {(items) => {
              const project = items.find((item) => item.id === projectId);
              if (!projectId && items[0])
                return <Navigate replace to={`/projects/${items[0].id}/experiments`} />;
              return project ? (
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
              );
            }}
          </Resource>
        </div>
      </div>
    </div>
  );
}
