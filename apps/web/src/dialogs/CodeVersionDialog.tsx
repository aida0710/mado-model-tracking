import type { Code, CodeVersion } from '@mmt/contracts';
import { useProject } from '../hooks/useProject';
import { useCodeVersionWorkspace } from '../hooks/useCodeVersionWorkspace';
import { Dialog } from '../components/Dialog';
import { CodeVersionFields } from '../components/CodeVersionFields';
import { CodeWorkspaceEditor } from '../components/CodeWorkspaceEditor';
import { UnsavedChangesDialog } from '../components/UnsavedChangesDialog';
import { ErrorNotice } from '../components/Feedback';
import { ArtifactUploadDialog } from './ArtifactUploadDialog';
import { text } from '../i18n/catalog';

export function CodeVersionDialog({ code, initialVersion, versions = [], onClose, onSaved }: {
  code: Code; initialVersion?: CodeVersion; versions?: CodeVersion[];
  onClose: () => void; onSaved: (version: CodeVersion) => void;
}) {
  const { project } = useProject();
  const workspace = useCodeVersionWorkspace({ projectId: project.id, codeId: code.id, initialVersion, versions, onNavigationDiscard: onClose });
  const { form, editor, sourceKind, baseVersion, sampleId, setSampleId, sampleError, isDirty, busy,
    unsaved, repositoryMode, changeValues, selectBaseVersion, changeRepositoryMode, applySample } = workspace;
  const editorVisible = sourceKind === 'git' || sourceKind === 'inline';
  return <>
    <Dialog title={`${code.name} · ${text.workspace}`} onClose={() => unsaved.requestAction(onClose)} busy={busy}
      wide className="workspace-dialog">
      <form onSubmit={(event) => {
        event.preventDefault();
        void form.save(editorVisible ? editor.workspace : undefined).then((version) => {
          if (version) onSaved(version);
        });
      }}>
        <p className="muted">{text.immutableVersionHint}</p>
        <fieldset disabled={busy}>
          {versions.length > 0 && <label className="field"><span>{text.baseVersion}</span>
            <select aria-label={text.baseVersion} value={baseVersion?.id ?? ''} onChange={(event) => selectBaseVersion(event.target.value)}>
              <option value="">{text.noBaseVersion}</option>
              {versions.map((version) => <option key={version.id} value={version.id}>{version.version}</option>)}
            </select>
          </label>}
          <div className="workspace-form-grid">
            <div className="workspace-settings">
              <CodeVersionFields values={form.values} artifacts={form.artifacts.items} onChange={changeValues}
                onUpload={form.openUpload} workspaceEnabled />
            </div>
            <div className="workspace-files">
              {editorVisible && <label className="field"><span>{text.repositoryMode}</span>
                <select aria-label={text.repositoryMode}
                  value={repositoryMode}
                  onChange={(event) => changeRepositoryMode(event.target.value as Parameters<typeof changeRepositoryMode>[0])}>
                  {baseVersion?.source?.kind === 'git' && <option value="same">{text.sameRepository}</option>}
                  <option value="other">{text.otherRepository}</option>
                  <option value="standalone">{text.standaloneSource}</option>
                </select>
              </label>}
              {editorVisible && <CodeWorkspaceEditor editor={editor} isGit={sourceKind === 'git'} disabled={busy}
                sampleId={sampleId} onSampleChange={setSampleId} onApplySample={applySample} />}
              <ErrorNotice message={sampleError} />
            </div>
          </div>
        </fieldset>
        {form.needsArtifacts && form.artifacts.loading && <p className="muted" role="status">{text.loading}</p>}
        <ErrorNotice message={form.needsArtifacts ? form.artifacts.error : null} retry={form.artifacts.reload} />
        <ErrorNotice message={form.savedArtifacts.error} retry={form.savedArtifacts.reload} />
        <ErrorNotice message={form.error} />
        <footer>
          {isDirty && <span className="muted unsaved-indicator">{text.unsavedChanges}</span>}
          <button type="button" className="button" onClick={() => unsaved.requestAction(onClose)} disabled={busy}>{text.cancel}</button>
          <button className="button primary" disabled={busy} data-testid="code-version-save">
            {form.pending ? text.loading : text.saveNewVersion}
          </button>
        </footer>
      </form>
    </Dialog>
    {unsaved.confirmingDiscard && <UnsavedChangesDialog onDiscard={unsaved.discard} onKeepEditing={unsaved.keepEditing} />}
    {form.uploadPurpose && <ArtifactUploadDialog projectId={project.id} runId={null}
      accept={form.uploadPurpose === 'sif' ? '.sif' : undefined} onClose={form.closeUpload} onSaved={form.selectUploadedArtifact} />}
  </>;
}
