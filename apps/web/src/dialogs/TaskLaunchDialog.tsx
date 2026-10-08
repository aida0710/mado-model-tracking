import type { ComputeTarget, ExperimentTask, ExecutionMode, TaskExecution } from '@mmt/contracts';
import type { ExecutionCatalog } from '../types/executionCatalog';
import { useProject } from '../hooks/useProject';
import { useTaskLaunchForm } from '../hooks/useTaskLaunchForm';
import { getExecutionCommand, hasOutputModel, outputModelLabel } from '../lib/taskInput';
import { workbenchTextTemplates } from '../i18n/workbench';
import { Dialog } from '../components/Dialog';
import { TaskFields } from '../components/TaskFields';
import { DetailsList, KeyValues } from '../components/JsonDetails';
import { ErrorNotice } from '../components/Feedback';
import { text } from '../i18n/catalog';

export function TaskLaunchDialog({ task, initialMode, catalog, targets, onClose, onSaved }: {
  task: ExperimentTask; initialMode: ExecutionMode; catalog: ExecutionCatalog; targets: ComputeTarget[];
  onClose: () => void; onSaved: (execution: TaskExecution) => void;
}) {
  const { project } = useProject();
  const form = useTaskLaunchForm({ projectId: project.id, task, initialMode, catalog, targets });
  const { mode } = form;
  const code = catalog.codeVersions.find((version) => version.id === task.codeVersionId);
  return <Dialog title={`${task.name} · ${text.taskLaunch}`} onClose={onClose} busy={form.pending} wide>
    <form onSubmit={(event) => {
      event.preventDefault();
      void form.launch().then((execution) => { if (execution) onSaved(execution); });
    }} data-testid="task-launch-form">
      <DetailsList entries={[[text.taskRevision, task.revision], [text.codeVersion, code?.version],
        [text.entrypoint, <code className="break-word">{JSON.stringify(code ? getExecutionCommand(code, mode) : [])}</code>]]} />
      {hasOutputModel(task.kind) && mode === 'run' && <p className="notice" data-testid="task-launch-registration">
        {task.outputModel ? workbenchTextTemplates.taskLaunchRegistration(outputModelLabel(task.outputModel, catalog)) : text.taskLaunchNoRegistration}
      </p>}
      <fieldset disabled={form.pending}>
        <details className="form-details"><summary>{text.parameters}</summary><KeyValues values={task.parameters} /></details>
        <label className="field"><span>{text.executionMode}</span>
          <select aria-label={text.executionMode} value={mode} onChange={(event) => form.changeMode(event.target.value as ExecutionMode)}>
            <option value="run">{text.runMode}</option><option value="test" disabled={!code?.testEntrypoint?.length}>{text.testMode}</option>
          </select>
        </label>
        {mode === 'test' && !code?.testEntrypoint?.length && <p className="notice">{text.testCommandRequired}</p>}
        <TaskFields values={form.values} catalog={catalog} targets={targets} launchOnly onChange={form.changeValues} />
      </fieldset>
      <ErrorNotice message={form.error} />
      <footer>
        <button type="button" className="button" disabled={form.pending} onClick={onClose}>{text.cancel}</button>
        <button className="button primary" disabled={form.pending || (mode === 'test' && !code?.testEntrypoint?.length)}>
          {form.pending ? text.loading : mode === 'test' ? text.launchTest : text.launchRun}
        </button>
      </footer>
    </form>
  </Dialog>;
}
