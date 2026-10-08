import { useState } from 'react';
import type { ArtifactBackend } from '@mmt/contracts';
import { administrationApi } from '../api/administration';
import { useProject } from '../hooks/useProject';
import { useQuery } from '../hooks/useQuery';
import { useMutation } from '../hooks/useMutation';
import { ErrorNotice, Resource } from './Feedback';
import { text } from '../i18n/catalog';

export function ProjectSettings() {
  const { project, isProjectAdmin, reloadProjects } = useProject();
  const [description, setDescription] = useState(project.description);
  const [backend, setBackend] = useState<ArtifactBackend>(project.artifactBackend);
  const [saved, setSaved] = useState(false);
  const backends = useQuery('settings-backends', administrationApi.backends);
  const mutation = useMutation();
  return (
    <section className="settings-section">
      <h2>{text.project}</h2>
      <Resource query={backends}>
        {(items) => (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              setSaved(false);
              void mutation.run(async () => {
                await administrationApi.updateProject(project.id, {
                  description,
                  artifactBackend: backend,
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
              <div className="field">
                <label htmlFor="project-artifact-backend">{text.storage}</label>
                <select
                  id="project-artifact-backend"
                  value={backend}
                  onChange={(event) => setBackend(event.target.value as ArtifactBackend)}
                >
                  {items.map((item) => (
                    <option key={item} value={item}>
                      {item === 'filesystem' || item === 's3' ? text[item] : item}
                    </option>
                  ))}
                </select>
              </div>
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
