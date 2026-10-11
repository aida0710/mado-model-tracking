import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, RefreshCw } from 'lucide-react';
import type { AdminProject } from '@mmt/contracts';
import { administrationApi } from '../../api/administration';
import { adminProjectsApi } from '../../api/adminProjects';
import { useAdminProjects } from '../../hooks/useAdminProjects';
import { explainProjectLifecycleConflict } from '../../lib/projectLifecycleConflict';
import { projectHomePath } from '../../layout/navigationLinks';
import { ProjectCreateDialog } from '../../dialogs/ProjectCreateDialog';
import { ConfirmDialog } from '../ConfirmDialog';
import { Resource } from '../Feedback';
import { AdminSectionHeader } from './AdminSectionHeader';
import { AdminProjectsTable, type AdminProjectAction } from './AdminProjectsTable';
import { ProjectPurgeDialog } from './ProjectPurgeDialog';
import { text, textTemplates } from '../../i18n/catalog';

interface PendingAction {
  project: AdminProject;
  action: AdminProjectAction;
}

/**
 * The admin "projects" section: every Project, creating one, archiving, and, with archived ones
 * shown, restoring or purging them.
 */
export function ProjectsPanel() {
  const navigate = useNavigate();
  const { projects, includeArchived, setIncludeArchived } = useAdminProjects();
  const [isCreating, setIsCreating] = useState(false);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const finishAction = () => {
    setPending(null);
    projects.reload();
  };
  return (
    <section className="admin-projects">
      <AdminSectionHeader
        section="projects"
        actions={
          <>
            <button className="button primary" onClick={() => setIsCreating(true)}>
              <Plus size={15} />
              {text.newProject}
            </button>
            <button className="icon-button" aria-label={text.refresh} onClick={projects.reload}>
              <RefreshCw size={17} />
            </button>
          </>
        }
      />
      <p className="muted">{text.adminProjectsDescription}</p>
      <label className="checkbox-field admin-projects-filter">
        <input
          type="checkbox"
          checked={includeArchived}
          onChange={(event) => setIncludeArchived(event.target.checked)}
        />
        {text.projectIncludeArchived}
      </label>
      <Resource query={projects}>
        {(items) => (
          <AdminProjectsTable
            projects={items}
            onAction={(project, action) => setPending({ project, action })}
          />
        )}
      </Resource>
      {isCreating && (
        <ProjectCreateDialog
          onClose={() => setIsCreating(false)}
          // The Project screens load the list again, so the new Project is there when it opens.
          onCreated={(project) => navigate(projectHomePath(project.id))}
        />
      )}
      {pending?.action === 'archive' && (
        <ConfirmDialog
          title={text.projectArchiveTitle}
          message={textTemplates.projectArchiveConfirm(pending.project.name)}
          confirmLabel={text.projectArchive}
          destructive
          onConfirm={() =>
            explainProjectLifecycleConflict(administrationApi.archiveProject(pending.project.id))
          }
          onConfirmed={finishAction}
          onClose={() => setPending(null)}
        />
      )}
      {pending?.action === 'restore' && (
        <ConfirmDialog
          title={text.projectRestoreTitle}
          message={textTemplates.projectRestoreConfirm(pending.project.name)}
          confirmLabel={text.projectRestore}
          onConfirm={() => adminProjectsApi.restore(pending.project.id)}
          onConfirmed={finishAction}
          onClose={() => setPending(null)}
        />
      )}
      {pending?.action === 'purge' && (
        <ProjectPurgeDialog
          project={pending.project}
          onPurged={finishAction}
          onClose={() => setPending(null)}
        />
      )}
    </section>
  );
}
