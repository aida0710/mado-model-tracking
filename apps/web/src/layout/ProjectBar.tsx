import { useNavigate } from 'react-router-dom';
import type { Project } from '@mmt/contracts';
import { text } from '../i18n/catalog';

/**
 * Which Project is open and the user's role in it. On wide screens it heads the navigation sidebar
 * ("sidebar"); on narrow ones it is the one-line bar under the header ("bar"), where the select
 * shrinks and truncates the Project name.
 */
export function ProjectBar({
  projects,
  project,
  placement,
}: {
  projects: Project[];
  project?: Project;
  placement: 'bar' | 'sidebar';
}) {
  const navigate = useNavigate();
  return (
    <div className={placement === 'sidebar' ? 'sidebar-project' : 'projectbar'}>
      <label>
        <span>{text.project}</span>
        <select
          aria-label={text.project}
          value={project?.id ?? ''}
          onChange={(event) => navigate(`/projects/${event.target.value}/experiments`)}
        >
          {!project && <option value="">{text.none}</option>}
          {projects.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </select>
      </label>
      {project && <span className="project-role">{text[project.role]}</span>}
    </div>
  );
}
