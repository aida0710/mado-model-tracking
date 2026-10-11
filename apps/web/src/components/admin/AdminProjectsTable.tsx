import { Link } from 'react-router-dom';
import type { AdminProject } from '@mmt/contracts';
import { ResponsiveTable } from '../ResponsiveTable';
import { ProjectVisibilityLabel } from '../ProjectVisibilityLabel';
import { formatDate } from '../../lib/format';
import { projectHomePath } from '../../layout/navigationLinks';
import { text, textTemplates } from '../../i18n/catalog';

export type AdminProjectAction = 'archive' | 'restore' | 'purge';

/**
 * Every Project with its visibility, members, Runs, storage, creation date and state. An active
 * Project opens from its name and can be archived; an archived one can be restored or purged.
 */
export function AdminProjectsTable({
  projects,
  onAction,
}: {
  projects: AdminProject[];
  onAction: (project: AdminProject, action: AdminProjectAction) => void;
}) {
  return (
    <ResponsiveTable
      rows={projects}
      rowKey={(project) => project.id}
      label={text.adminSectionProjects}
      empty={text.adminProjectsEmpty}
      columns={[
        {
          key: 'name',
          priority: 'primary',
          header: text.name,
          render: (project) =>
            project.archivedAt === null ? (
              <Link to={projectHomePath(project.id)}>{project.name}</Link>
            ) : (
              project.name
            ),
        },
        {
          key: 'visibility',
          priority: 'primary',
          header: text.projectVisibility,
          render: (project) => <ProjectVisibilityLabel visibility={project.visibility} />,
        },
        {
          key: 'members',
          priority: 'secondary',
          header: text.projectMemberCount,
          render: (project) => project.memberCount,
        },
        {
          key: 'runs',
          priority: 'secondary',
          header: text.projectRunCount,
          render: (project) => project.runCount,
        },
        {
          key: 'storage',
          priority: 'secondary',
          header: text.storage,
          className: 'mono',
          render: (project) => project.artifactBackend,
        },
        {
          key: 'created',
          priority: 'secondary',
          header: text.created,
          render: (project) => formatDate(project.createdAt),
        },
        {
          key: 'state',
          priority: 'primary',
          header: text.status,
          render: (project) =>
            project.archivedAt === null ? (
              <span className="status-badge status-finished">{text.projectStateActive}</span>
            ) : (
              <span
                className="status-badge status-canceled"
                title={textTemplates.projectArchivedAt(formatDate(project.archivedAt))}
              >
                {text.projectStateArchived}
              </span>
            ),
        },
        {
          key: 'actions',
          priority: 'secondary',
          header: text.actions,
          render: (project) => (
            <div className="access-actions">
              {project.archivedAt === null ? (
                <button className="button small" onClick={() => onAction(project, 'archive')}>
                  {text.projectArchive}
                </button>
              ) : (
                <>
                  <button className="button small" onClick={() => onAction(project, 'restore')}>
                    {text.projectRestore}
                  </button>
                  <button
                    className="button small danger"
                    onClick={() => onAction(project, 'purge')}
                  >
                    {text.projectPurge}
                  </button>
                </>
              )}
            </div>
          ),
        },
      ]}
    />
  );
}
