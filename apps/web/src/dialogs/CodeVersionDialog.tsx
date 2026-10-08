import type { Code, CodeVersion } from '@mmt/contracts';
import { useProject } from '../hooks/useProject';
import { useCodeVersionForm } from '../hooks/useCodeVersionForm';
import { Dialog } from '../components/Dialog';
import { CodeVersionFields } from '../components/CodeVersionFields';
import { ErrorNotice } from '../components/Feedback';
import { ArtifactUploadDialog } from './ArtifactUploadDialog';
import { text } from '../i18n/catalog';

export function CodeVersionDialog({
  code,
  onClose,
  onSaved,
}: {
  code: Code;
  onClose: () => void;
  onSaved: (version: CodeVersion) => void;
}) {
  const { project } = useProject();
  const form = useCodeVersionForm({ projectId: project.id, codeId: code.id });
  return (
    <>
      <Dialog title={`${code.name} · ${text.newVersion}`} onClose={onClose} busy={form.pending}>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void form.save().then((version) => {
              if (version) onSaved(version);
            });
          }}
        >
          <fieldset disabled={form.pending}>
            <CodeVersionFields
              values={form.values}
              artifacts={form.artifacts.items}
              onChange={form.changeValues}
              onUpload={form.openUpload}
            />
          </fieldset>
          {form.needsArtifacts && form.artifacts.loading && (
            <p className="muted" role="status">
              {text.loading}
            </p>
          )}
          <ErrorNotice
            message={form.needsArtifacts ? form.artifacts.error : null}
            retry={form.artifacts.reload}
          />
          <ErrorNotice message={form.error} />
          <footer>
            <button type="button" className="button" onClick={onClose} disabled={form.pending}>
              {text.cancel}
            </button>
            <button className="button primary" disabled={form.pending}>
              {form.pending ? text.loading : text.save}
            </button>
          </footer>
        </form>
      </Dialog>
      {form.uploadPurpose && (
        <ArtifactUploadDialog
          projectId={project.id}
          runId={null}
          accept={form.uploadPurpose === 'sif' ? '.sif' : undefined}
          onClose={form.closeUpload}
          onSaved={form.selectUploadedArtifact}
        />
      )}
    </>
  );
}
