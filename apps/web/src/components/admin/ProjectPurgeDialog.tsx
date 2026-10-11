import { useId, useState } from 'react';
import type { AdminProject } from '@mmt/contracts';
import { adminProjectsApi } from '../../api/adminProjects';
import { useMutation } from '../../hooks/useMutation';
import { explainProjectLifecycleConflict } from '../../lib/projectLifecycleConflict';
import { Dialog } from '../Dialog';
import { ErrorNotice } from '../Feedback';
import { text, textTemplates } from '../../i18n/catalog';

/**
 * Purges an archived Project for good. The Project's name must be typed first, because the Runs,
 * models and Artifact files go with it and nothing brings them back.
 */
export function ProjectPurgeDialog({
  project,
  onPurged,
  onClose,
}: {
  project: AdminProject;
  onPurged: () => void;
  onClose: () => void;
}) {
  const nameInputId = useId();
  const [typedName, setTypedName] = useState('');
  const mutation = useMutation();
  const isNameConfirmed = typedName === project.name;
  return (
    <Dialog
      title={text.projectPurgeTitle}
      onClose={onClose}
      busy={mutation.pending}
      fullScreenOnNarrow={false}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!isNameConfirmed) return;
          void mutation
            .run(async () => {
              await explainProjectLifecycleConflict(adminProjectsApi.purge(project.id));
              return true;
            })
            .then((purged) => {
              if (purged) onPurged();
            });
        }}
      >
        <p>{textTemplates.projectPurgeConfirm(project.name)}</p>
        <div className="field">
          <label htmlFor={nameInputId}>{text.projectPurgeNameLabel}</label>
          <input
            id={nameInputId}
            value={typedName}
            autoComplete="off"
            placeholder={project.name}
            disabled={mutation.pending}
            onChange={(event) => setTypedName(event.target.value)}
          />
        </div>
        <ErrorNotice message={mutation.error} />
        <footer>
          <button type="button" className="button" onClick={onClose} disabled={mutation.pending}>
            {text.cancel}
          </button>
          <button className="button danger" disabled={!isNameConfirmed || mutation.pending}>
            {mutation.pending ? text.loading : text.projectPurge}
          </button>
        </footer>
      </form>
    </Dialog>
  );
}
