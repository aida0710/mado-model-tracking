import { useState } from 'react';
import { Upload } from 'lucide-react';
import { ArtifactUploadDialog } from '../dialogs/ArtifactUploadDialog';
import { text } from '../i18n/catalog';

/** Uploads Artifacts without a Run; each finished file shows its artifact:// URI to copy. */
export function StandaloneArtifactUpload({ projectId }: { projectId: string }) {
  const [isOpen, setIsOpen] = useState(false);
  return (
    <>
      <button className="button" onClick={() => setIsOpen(true)}>
        <Upload size={15} />
        {text.uploadArtifact}
      </button>
      {isOpen && (
        <ArtifactUploadDialog
          projectId={projectId}
          runId={null}
          multiple
          onClose={() => setIsOpen(false)}
          onSaved={() => undefined}
        />
      )}
    </>
  );
}
