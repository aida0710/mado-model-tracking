import { useState } from 'react';
import type { Project, ProjectVisibility } from '@mmt/contracts';
import { administrationApi } from '../api/administration';
import { useStorageBackendChoices } from '../hooks/useStorageBackends';
import { useMutation } from '../hooks/useMutation';
import { QueryDialog } from '../components/QueryDialog';
import { Dialog } from '../components/Dialog';
import { ErrorNotice } from '../components/Feedback';
import { ProjectMemberGrantsField } from '../components/ProjectMemberGrantsField';
import { ProjectVisibilityPicker } from '../components/ProjectVisibilityPicker';
import { StorageBackendPicker } from '../components/StorageBackendPicker';
import type { StorageBackendChoice } from '../hooks/useStorageBackends';
import { buildProjectCreate, DEFAULT_PROJECT_VISIBILITY } from '../lib/projectCreateInput';
import type { MemberGrantDraft } from '../lib/projectMemberGrants';
import { text } from '../i18n/catalog';

/**
 * Creates a Project: name, description, visibility (with members for a Private one) and storage.
 * The Project switcher, the admin Project list and the screen shown without Projects all open
 * this one dialog; the caller opens the created Project.
 */
export function ProjectCreateDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (project: Project) => void;
}) {
  const backends = useStorageBackendChoices();
  return (
    <QueryDialog title={text.newProject} onClose={onClose} query={backends}>
      {(choices) => (
        <ProjectCreateForm
          choices={choices.items}
          defaultBackend={choices.defaultBackend}
          onClose={onClose}
          onCreated={onCreated}
        />
      )}
    </QueryDialog>
  );
}

function ProjectCreateForm({
  choices,
  defaultBackend,
  onClose,
  onCreated,
}: {
  choices: StorageBackendChoice[];
  defaultBackend: string;
  onClose: () => void;
  onCreated: (project: Project) => void;
}) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [visibility, setVisibility] = useState<ProjectVisibility>(DEFAULT_PROJECT_VISIBILITY);
  const [memberDrafts, setMemberDrafts] = useState<MemberGrantDraft[]>([]);
  // New Projects start on the backend the global administrator chose as the default.
  const [backend, setBackend] = useState(defaultBackend);
  const mutation = useMutation();
  return (
    <Dialog title={text.newProject} onClose={onClose} busy={mutation.pending}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void mutation
            .run(() =>
              administrationApi.createProject(
                buildProjectCreate({
                  name,
                  description,
                  visibility,
                  artifactBackend: backend,
                  memberDrafts,
                }),
              ),
            )
            .then((project) => {
              if (project) onCreated(project);
            });
        }}
      >
        <fieldset disabled={mutation.pending}>
          <div className="field">
            <label htmlFor="new-project-name">
              {text.name}
              <span className="required" aria-hidden="true">
                {' '}
                *
              </span>
            </label>
            <input
              id="new-project-name"
              value={name}
              required
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="new-project-description">{text.projectDescriptionOptional}</label>
            <textarea
              id="new-project-description"
              value={description}
              rows={3}
              onChange={(event) => setDescription(event.target.value)}
            />
          </div>
          <ProjectVisibilityPicker
            name="new-project-visibility"
            value={visibility}
            onChange={setVisibility}
          />
          {visibility === 'private' && (
            <ProjectMemberGrantsField drafts={memberDrafts} onChange={setMemberDrafts} />
          )}
          <StorageBackendPicker
            name="new-project-artifact-backend"
            choices={choices}
            defaultBackend={defaultBackend}
            value={backend}
            onChange={setBackend}
          />
        </fieldset>
        <ErrorNotice message={mutation.error} />
        <footer>
          <button type="button" className="button" onClick={onClose} disabled={mutation.pending}>
            {text.cancel}
          </button>
          <button className="button primary" disabled={mutation.pending}>
            {mutation.pending ? text.loading : text.create}
          </button>
        </footer>
      </form>
    </Dialog>
  );
}
