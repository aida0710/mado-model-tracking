import { useState } from 'react';
import type { Artifact } from '@mmt/contracts';
import { Upload } from 'lucide-react';
import { Dialog } from './Dialog';
import { CopyButton } from './CopyButton';
import { ArtifactUploadDialog } from '../dialogs/ArtifactUploadDialog';
import { text } from '../i18n/catalog';

export function StandaloneArtifactUpload({ projectId }: { projectId: string }) {
  const [isOpen, setIsOpen] = useState(false);
  const [artifact, setArtifact] = useState<Artifact | null>(null);
  function close() {
    setIsOpen(false);
    setArtifact(null);
  }
  return (
    <>
      <button className="button" onClick={() => setIsOpen(true)}>
        <Upload size={15} />
        {text.uploadArtifact}
      </button>
      {isOpen &&
        (artifact ? (
          <Dialog title={text.uploadArtifact} onClose={close}>
            <div className="artifact-upload-result">
              <p className="notice success" role="status">
                {text.success}: {artifact.path}
              </p>
              <h3>{text.artifactId}</h3>
              <pre>{artifact.id}</pre>
              <CopyButton value={artifact.id} />
              <h3>{text.uri}</h3>
              <pre>artifact://{artifact.id}</pre>
            </div>
            <footer>
              <button className="button primary" onClick={close}>
                {text.close}
              </button>
            </footer>
          </Dialog>
        ) : (
          <ArtifactUploadDialog
            projectId={projectId}
            runId={null}
            onClose={close}
            onSaved={setArtifact}
          />
        ))}
    </>
  );
}
