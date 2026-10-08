import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Plus } from 'lucide-react';
import type { Project } from '@mmt/contracts';
import { useAuth } from '../hooks/useAuth';
import { canCreateProject } from '../lib/permissions';
import { formatDate } from '../lib/format';
import { DataTable } from './DataTable';
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
        <DataTable
          items={projects}
          rowKey={(project) => project.id}
          columns={[
            {
              key: 'name',
              label: text.name,
              render: (project) => (
                <Link to={`/projects/${project.id}/experiments`}>{project.name}</Link>
              ),
            },
            { key: 'role', label: text.role, render: (project) => text[project.role] },
            {
              key: 'description',
              label: text.description,
              render: (project) => project.description,
            },
            {
              key: 'created',
              label: text.created,
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
