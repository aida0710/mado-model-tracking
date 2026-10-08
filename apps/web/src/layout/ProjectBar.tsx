import { useNavigate } from 'react-router-dom';
import type { Project } from '@mmt/contracts';
import { text } from '../i18n/catalog';

/**
 * The bar under the header: which Project is open and the user's role in it. It stays one line on
 * every width; on narrow screens the select shrinks and truncates the Project name.
 */
export function ProjectBar({ projects, project }: { projects: Project[]; project?: Project }) {
  const navigate = useNavigate();
  return (
    <div className="projectbar">
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
