import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Plus } from 'lucide-react';
import type { Project } from '@mmt/contracts';
import { useAuth } from '../hooks/useAuth';
import { canCreateProject } from '../lib/permissions';
import { formatDate } from '../lib/format';
import { ResponsiveTable } from './ResponsiveTable';
import { ProjectDialog } from '../dialogs/ProjectDialog';
import { text } from '../i18n/catalog';

/** The "Projects" settings section: every Project the user can open, and Project creation. */
export function ProjectList({
  projects,
  onCreated,
}: {
  projects: Project[];
  onCreated: () => void;
}) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [showCreate, setShowCreate] = useState(false);
  return (
    <section className="settings-section">
      <div className="section-heading">
        <h2>{text.projects}</h2>
        {canCreateProject(user) && (
          <button className="button small" onClick={() => setShowCreate(true)}>
            <Plus size={14} />
            {text.newProject}
          </button>
        )}
      </div>
      {/* With no Project yet, the page around this section already explains what to do. */}
      {projects.length > 0 && (
        <ResponsiveTable
          rows={projects}
          rowKey={(project) => project.id}
          columns={[
            {
              key: 'name',
              priority: 'primary',
              header: text.name,
              render: (project) => (
                <Link to={`/projects/${project.id}/experiments`}>{project.name}</Link>
              ),
            },
            {
              key: 'role',
              priority: 'primary',
              header: text.role,
              render: (project) => text[project.role],
            },
            {
              key: 'description',
              priority: 'secondary',
              header: text.description,
              render: (project) => project.description,
            },
            {
              key: 'created',
              priority: 'secondary',
              header: text.created,
              render: (project) => formatDate(project.createdAt),
            },
          ]}
        />
      )}
      {showCreate && (
        <ProjectDialog
          onClose={() => setShowCreate(false)}
          onSaved={(project) => {
            setShowCreate(false);
            onCreated();
            navigate(`/projects/${project.id}/experiments`);
          }}
        />
      )}
    </section>
  );
}
