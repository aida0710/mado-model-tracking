import { useEffect, useState, type CSSProperties } from 'react';
import { Navigate, Outlet, useNavigate, useParams } from 'react-router-dom';
import { Plus } from 'lucide-react';
import type { Project } from '@mmt/contracts';
import { administrationApi } from '../api/administration';
import { useAuth } from '../hooks/useAuth';
import { useQuery } from '../hooks/useQuery';
import { ProjectContext } from '../hooks/useProject';
import { useNavigation } from '../hooks/useNavigation';
import { Loading, Resource } from '../components/Feedback';
import { PageHeader } from '../components/PageHeader';
import { ProjectCreateDialog } from '../dialogs/ProjectCreateDialog';
import { canCreateProject } from '../lib/permissions';
import { projectToOpen, readLastProjectId, rememberLastProjectId } from '../lib/lastOpenedProject';
import { text } from '../i18n/catalog';
import { TopBar } from './TopBar';
import { ProjectBar } from './ProjectBar';
import { NavigationSidebar } from './NavigationSidebar';
import { projectHomePath } from './navigationLinks';

export function AppShell() {
  const { projectId } = useParams();
  const auth = useAuth();
  const navigate = useNavigate();
  const projects = useQuery('projects', administrationApi.projects);
  const [isCreatingProject, setIsCreatingProject] = useState(false);
  const startCreatingProject = canCreateProject(auth.user)
    ? () => setIsCreatingProject(true)
    : undefined;
  const openCreatedProject = (project: Project) => {
    setIsCreatingProject(false);
    projects.reload();
    navigate(projectHomePath(project.id));
  };
  // A Project id from the URL that the user cannot open gets no Project navigation or alerts.
  const openProject = projects.value?.find((project) => project.id === projectId);
  useEffect(() => {
    if (openProject) rememberLastProjectId(openProject.id);
  }, [openProject]);
  const navigation = useNavigation(openProject?.id, openProject?.role);
  // The Project switcher heads the full sidebar; with the rail or the drawer it is the bar under
  // the header.
  const inSidebar = navigation.mode === 'sidebar';
  const projectPicker = projects.value?.length ? (
    <ProjectBar
      projects={projects.value}
      project={openProject}
      placement={inSidebar ? 'sidebar' : 'bar'}
      onCreateProject={startCreatingProject}
    />
  ) : null;
  return (
    <div
      className="app-shell"
      data-navigation={navigation.mode}
      data-project-bar={projectPicker && !inSidebar ? 'true' : undefined}
      style={{ '--navigation-width': `${navigation.width}px` } as CSSProperties}
    >
      <TopBar projectId={openProject?.id} navigation={navigation} />
      <div className="app-body">
        {navigation.mode !== 'drawer' && (projectPicker || navigation.groups.length > 0) && (
          <NavigationSidebar navigation={navigation}>{inSidebar && projectPicker}</NavigationSidebar>
        )}
        <div className="app-content">
          {!inSidebar && projectPicker}
          <Resource query={projects}>
            {(items) => {
              const project = items.find((item) => item.id === projectId);
              // A list being reloaded may still lack a Project just created, or still hold one
              // just archived; wait for it instead of showing the wrong screen.
              if (!project && projects.loading) return <Loading />;
              const projectAtHome = projectId ? undefined : projectToOpen(items, readLastProjectId());
              if (projectAtHome) return <Navigate replace to={projectHomePath(projectAtHome.id)} />;
              return project ? (
                <ProjectContext.Provider
                  value={{ project, projects: items, reloadProjects: projects.reload }}
                >
                  <main id="content" className="workspace" key={project.id}>
                    <Outlet />
                  </main>
                </ProjectContext.Provider>
              ) : (
                <NoOpenProject
                  isUnreachable={Boolean(projectId)}
                  hasProjects={items.length > 0}
                  onCreateProject={startCreatingProject}
                />
              );
            }}
          </Resource>
        </div>
      </div>
      {isCreatingProject && (
        <ProjectCreateDialog
          onClose={() => setIsCreatingProject(false)}
          onCreated={openCreatedProject}
        />
      )}
    </div>
  );
}

/**
 * Shown when no Project is open: the URL names one the user cannot open, or they have none. Those
 * who may create a Project get the button; the others are told whom to ask.
 */
function NoOpenProject({
  isUnreachable,
  hasProjects,
  onCreateProject,
}: {
  isUnreachable: boolean;
  hasProjects: boolean;
  onCreateProject?: () => void;
}) {
  return (
    <main id="content" className="page">
      <PageHeader
        title={text.project}
        actions={
          onCreateProject && (
            <button className="button primary" onClick={onCreateProject}>
              <Plus size={15} />
              {text.newProject}
            </button>
          )
        }
      />
      {isUnreachable && <p className="notice error">{text.projectNotAccessible}</p>}
      {!hasProjects && (
        <>
          <p className="muted">{text.noProjects}</p>
          <p className="muted">
            {onCreateProject ? text.noProjectsCreateHint : text.noProjectsAskAdmin}
          </p>
        </>
      )}
    </main>
  );
}
