import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Archive } from 'lucide-react';
import { administrationApi } from '../api/administration';
import { useProject } from '../hooks/useProject';
import { explainProjectLifecycleConflict } from '../lib/projectLifecycleConflict';
import { ConfirmDialog } from './ConfirmDialog';
import { text, textTemplates } from '../i18n/catalog';

/**
 * The end of the Project settings for its admin: archiving hides the Project and keeps its data,
 * which a global administrator can restore. Afterwards the user is sent to another Project.
 */
export function ProjectArchiveSection() {
  const { project, reloadProjects } = useProject();
  const navigate = useNavigate();
  const [isConfirming, setIsConfirming] = useState(false);
  return (
    <section className="settings-section project-archive">
      <h2>{text.projectArchiveTitle}</h2>
      <p className="muted">{text.projectArchiveDescription}</p>
      <button className="button danger" onClick={() => setIsConfirming(true)}>
        <Archive size={15} />
        {text.projectArchive}
      </button>
      {isConfirming && (
        <ConfirmDialog
          title={text.projectArchiveTitle}
          message={textTemplates.projectArchiveConfirm(project.name)}
          confirmLabel={text.projectArchive}
          destructive
          onConfirm={() =>
            explainProjectLifecycleConflict(administrationApi.archiveProject(project.id))
          }
          onConfirmed={() => {
            setIsConfirming(false);
            reloadProjects();
            navigate('/');
          }}
          onClose={() => setIsConfirming(false)}
        />
      )}
    </section>
  );
}
