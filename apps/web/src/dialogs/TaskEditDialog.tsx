import { useRef, useState } from 'react';
import type { ComputeTarget, ExperimentTask } from '@mmt/contracts';
import type { ExecutionCatalog } from '../types/executionCatalog';
import { useProject } from '../hooks/useProject';
import { useTaskForm } from '../hooks/useTaskForm';
import { useUnsavedChanges } from '../hooks/useUnsavedChanges';
import { Dialog } from '../components/Dialog';
import { TaskFields } from '../components/TaskFields';
import { CodeRuntimeDetails } from '../components/CodeRuntimeDetails';
import { ErrorNotice } from '../components/Feedback';
import { UnsavedChangesDialog } from '../components/UnsavedChangesDialog';
import { CodeVersionDialog } from './CodeVersionDialog';
import { text } from '../i18n/catalog';

export function TaskEditDialog({ task, experimentId, catalog, targets, onClose, onSaved }: {
  task?: ExperimentTask; experimentId?: string; catalog: ExecutionCatalog; targets: ComputeTarget[];
  onClose: () => void; onSaved: (task: ExperimentTask) => void;
}) {
  const { project } = useProject();
  const form = useTaskForm({ projectId: project.id, task, experimentId, catalog, targets });
  const initialValues = useRef(JSON.stringify(form.values));
  const unsaved = useUnsavedChanges(JSON.stringify(form.values) !== initialValues.current, form.pending, { onNavigationDiscard: onClose });
  const [showCodeEditor, setShowCodeEditor] = useState(false);
  const selectedVersion = form.catalog.codeVersions.find((version) => version.id === form.values.codeVersionId);
  const selectedCode = form.catalog.codes.find((code) => code.id === selectedVersion?.codeId);
  return <>
    <Dialog fullScreenOnNarrow title={task ? text.editTask : text.newTask} onClose={() => unsaved.requestAction(onClose)} busy={form.pending} wide>
      <form onSubmit={(event) => {
        event.preventDefault();
        void form.save().then((saved) => { if (saved) onSaved(saved); });
      }} data-testid="task-edit-form">
        {task && <p className="muted">{text.taskRevision}: {task.revision} · {catalog.experiments.find((item) => item.id === task.experimentId)?.name}</p>}
        <fieldset disabled={form.pending}>
          <TaskFields values={form.values} catalog={form.catalog} targets={targets} onChange={form.changeValues} isEditing={!!task} />
          {selectedCode && <button type="button" className="button" data-testid="task-edit-code" onClick={() => setShowCodeEditor(true)}>
            {text.editCodeVersion}
          </button>}
          {selectedVersion && <CodeRuntimeDetails version={selectedVersion} />}
        </fieldset>
        <ErrorNotice message={form.error} />
        <footer>
          <button type="button" className="button" disabled={form.pending} onClick={() => unsaved.requestAction(onClose)}>{text.cancel}</button>
          <button className="button primary" disabled={form.pending}>{form.pending ? text.loading : text.save}</button>
        </footer>
      </form>
    </Dialog>
    {unsaved.confirmingDiscard && <UnsavedChangesDialog onDiscard={unsaved.discard} onKeepEditing={unsaved.keepEditing} />}
    {showCodeEditor && selectedCode && <CodeVersionDialog code={selectedCode} initialVersion={selectedVersion}
      versions={form.catalog.codeVersions.filter((version) => version.codeId === selectedCode.id)}
      onClose={() => setShowCodeEditor(false)} onSaved={(version) => { form.selectSavedCodeVersion(version); setShowCodeEditor(false); }} />}
  </>;
}
