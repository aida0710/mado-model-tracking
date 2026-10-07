import { useState } from 'react';
import type { Artifact } from '@mmt/contracts';
import { Dialog } from '../components/Dialog';
import { ErrorNotice } from '../components/Feedback';
import { useMutation } from '../hooks/useMutation';
import { trackingApi } from '../api/tracking';
import { text } from '../i18n/catalog';

export function ArtifactUploadDialog({
  projectId,
  runId,
  onClose,
  onSaved,
}: {
  projectId: string;
  runId: string | null;
  onClose: () => void;
  onSaved: (artifact: Artifact) => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [path, setPath] = useState('');
  const mutation = useMutation();
  return (
    <Dialog title={text.uploadArtifact} onClose={onClose} busy={mutation.pending}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (file)
            void mutation.run(async () => {
              const artifact = await trackingApi.uploadArtifact(projectId, runId, path, file);
              onSaved(artifact);
            });
        }}
      >
        <fieldset disabled={mutation.pending}>
          <label className="field">
            <span>{text.chooseFile}</span>
            <input
              type="file"
              required
              onChange={(event) => {
                const selected = event.target.files?.[0] ?? null;
                setFile(selected);
                if (selected) setPath(selected.name);
              }}
            />
          </label>
          <label className="field">
            <span>{text.artifactPath}</span>
            <input required value={path} onChange={(event) => setPath(event.target.value)} />
          </label>
        </fieldset>
        <ErrorNotice message={mutation.error} />
        <footer>
          <button type="button" className="button" disabled={mutation.pending} onClick={onClose}>
            {text.cancel}
          </button>
          <button className="button primary" disabled={mutation.pending || !file}>
            {text.upload}
          </button>
        </footer>
      </form>
    </Dialog>
  );
}
