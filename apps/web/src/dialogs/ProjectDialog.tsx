import { useState } from 'react';
import type { Project } from '@mmt/contracts';
import { administrationApi } from '../api/administration';
import { useStorageBackendChoices } from '../hooks/useStorageBackends';
import { useMutation } from '../hooks/useMutation';
import { QueryDialog } from '../components/QueryDialog';
import { Dialog } from '../components/Dialog';
import { ErrorNotice } from '../components/Feedback';
import { StorageBackendPicker } from '../components/StorageBackendPicker';
import type { StorageBackendChoice } from '../hooks/useStorageBackends';
import { text } from '../i18n/catalog';

export function ProjectDialog({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: (project: Project) => void;
}) {
  const backends = useStorageBackendChoices();
  return (
    <QueryDialog title={text.newProject} onClose={onClose} query={backends}>
      {(choices) => (
        <ProjectForm
          choices={choices.items}
          defaultBackend={choices.defaultBackend}
          onClose={onClose}
          onSaved={onSaved}
          submitLabel={text.create}
          fields={[
            { name: 'name', label: text.name, required: true },
            { name: 'description', label: text.description, type: 'textarea' },
            {
              name: 'artifactBackend',
              label: text.storage,
              type: 'select',
              defaultValue: items[0],
              options: items.map((backend) => ({
                value: backend,
                label: backend === 'filesystem' || backend === 's3' ? text[backend] : backend,
              })),
              required: true,
            },
          ]}
          onSubmit={(values) =>
            administrationApi.createProject({
              name: getFieldValue(values, 'name'),
              description: getOptionalValue(values, 'description'),
              artifactBackend: getFieldValue(
                values,
                'artifactBackend',
              ) as Project['artifactBackend'],
            })
          }
        />
      )}
    </QueryDialog>
  );
}

function ProjectForm({
  choices,
  defaultBackend,
  onClose,
  onSaved,
}: {
  choices: StorageBackendChoice[];
  defaultBackend: string;
  onClose: () => void;
  onSaved: (project: Project) => void;
}) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
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
              administrationApi.createProject({
                name: name.trim(),
                description: description.trim() || undefined,
                artifactBackend: backend,
              }),
            )
            .then((project) => {
              if (project) onSaved(project);
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
            <label htmlFor="new-project-description">{text.description}</label>
            <textarea
              id="new-project-description"
              value={description}
              rows={4}
              onChange={(event) => setDescription(event.target.value)}
            />
          </div>
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
