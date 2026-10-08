import { useState } from 'react';
import type { ArtifactBackend } from '@mmt/contracts';
import { administrationApi } from '../api/administration';
import { useProject } from '../hooks/useProject';
import { useStorageBackendChoices } from '../hooks/useStorageBackends';
import { useMutation } from '../hooks/useMutation';
import { ErrorNotice, Resource } from './Feedback';
import { StorageBackendPicker } from './StorageBackendPicker';
import { text } from '../i18n/catalog';

export function ProjectSettings() {
  const { project, isProjectAdmin, reloadProjects } = useProject();
  const [description, setDescription] = useState(project.description);
  const [backend, setBackend] = useState<ArtifactBackend>(project.artifactBackend);
  const [saved, setSaved] = useState(false);
  const backends = useStorageBackendChoices();
  const mutation = useMutation();
  return (
    <section className="settings-section">
      <h2>{text.project}</h2>
      <Resource query={backends}>
        {(choices) => (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              setSaved(false);
              void mutation.run(async () => {
                await administrationApi.updateProject(project.id, {
                  description,
                  // Sent only when changed: a disabled backend stays valid for existing Projects.
                  ...(backend !== project.artifactBackend ? { artifactBackend: backend } : {}),
                });
                setSaved(true);
                reloadProjects();
              });
            }}
          >
            <fieldset disabled={!isProjectAdmin || mutation.pending}>
              <div className="field">
                <label htmlFor="project-description">{text.description}</label>
                <textarea
                  id="project-description"
                  value={description}
                  rows={3}
                  onChange={(event) => setDescription(event.target.value)}
                />
              </div>
              <StorageBackendPicker
                name="project-artifact-backend"
                choices={choices.items}
                defaultBackend={choices.defaultBackend}
                value={backend}
                onChange={setBackend}
              />
            </fieldset>
            <ErrorNotice message={mutation.error} />
            {saved && (
              <p className="notice success" role="status">
                {text.projectSaved}
              </p>
            )}
            {isProjectAdmin && (
              <button className="button primary" disabled={mutation.pending}>
                {text.save}
              </button>
            )}
          </form>
        )}
      </Resource>
    </section>
  );
}
