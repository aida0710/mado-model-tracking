import type { Project } from '@mmt/contracts';
import { text } from '../i18n/catalog';
import { ProjectSwitcher } from './ProjectSwitcher';

/**
 * Which Project is open and the user's role in it. On wide screens it heads the navigation sidebar
 * ("sidebar"); on narrow ones it is the one-line bar under the header ("bar"), where the switcher
 * shrinks and truncates the Project name.
 */
export function ProjectBar({
  projects,
  project,
  placement,
  onCreateProject,
}: {
  projects: Project[];
  project?: Project;
  placement: 'bar' | 'sidebar';
  /** Offered at the end of the switcher to those who may create a Project. */
  onCreateProject?: () => void;
}) {
  return (
    <div className={placement === 'sidebar' ? 'sidebar-project' : 'projectbar'}>
      <ProjectSwitcher projects={projects} project={project} onCreateProject={onCreateProject} />
      {project && <span className="project-role">{text[project.role]}</span>}
    </div>
  );
}
