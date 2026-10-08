import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Play, Plus, RefreshCw } from 'lucide-react';
import type { ExperimentTask, ExecutionMode } from '@mmt/contracts';
import { tasksApi } from '../api/tasks';
import { executionApi } from '../api/execution';
import { useProject } from '../hooks/useProject';
import { useExecutionCatalog } from '../hooks/useExecutionCatalog';
import { useQuery } from '../hooks/useQuery';
import { useTaskRunHistory } from '../hooks/useTaskRunHistory';
import { PageHeader } from '../components/PageHeader';
import { Resource } from '../components/Feedback';
import { DataTable } from '../components/DataTable';
import { RegistryLayout } from '../components/RegistryLayout';
import { TaskDetails } from '../components/TaskDetails';
import { TaskRunHistory } from '../components/TaskRunHistory';
import { TaskHistoryPagination } from '../components/TaskHistoryPagination';
import { TaskEditDialog } from '../dialogs/TaskEditDialog';
import { TaskLaunchDialog } from '../dialogs/TaskLaunchDialog';
import { text } from '../i18n/catalog';

type TaskDialog = { kind: 'create' } | { kind: 'edit'; task: ExperimentTask } |
  { kind: 'launch'; task: ExperimentTask; mode: ExecutionMode };

export function TasksPage() {
  const { project, canEdit } = useProject();
  const [params, setParams] = useSearchParams();
  const experimentId = params.get('experiment') ?? '';
  const [dialog, setDialog] = useState<TaskDialog | null>(null);
  const catalog = useExecutionCatalog(project.id);
  const targets = useQuery('task-targets', executionApi.targets);
  const tasks = useQuery(`${project.id}:tasks:${experimentId}`, (signal) => tasksApi.list(project.id, experimentId || undefined, signal));
  const selected = tasks.value?.find((task) => task.id === params.get('id')) ?? tasks.value?.[0];
  const history = useTaskRunHistory({ projectId: project.id, taskId: selected?.id });
  function reload() { tasks.reload(); catalog.reload(); targets.reload(); history.reload(); }
  function selectTask(task: ExperimentTask) {
    setParams((previous) => { const next = new URLSearchParams(previous); next.set('id', task.id); next.delete('historyCursor'); return next; });
  }
  return <section className="page tasks-page" data-testid="tasks-page">
    <PageHeader title={text.tasks} eyebrow={project.name} actions={<>
      {canEdit && <button className="button primary" onClick={() => setDialog({ kind: 'create' })}><Plus size={15} />{text.newTask}</button>}
      <button className="icon-button" aria-label={text.refresh} onClick={reload}><RefreshCw size={17} /></button>
    </>} />
    <Resource query={catalog}>{(entries) => <Resource query={targets}>{(computeTargets) => <>
      <label className="chart-selector"><span>{text.experiments}</span>
        <select aria-label={text.experiments} value={experimentId} onChange={(event) => setParams(event.target.value ? { experiment: event.target.value } : {})}>
          <option value="">{text.allExperiments}</option>
          {entries.experiments.map((experiment) => <option key={experiment.id} value={experiment.id}>{experiment.name}</option>)}
        </select>
      </label>
      <Resource query={tasks}>{(items) => <RegistryLayout list={<DataTable items={items} rowKey={(task) => task.id}
        selectedKey={selected?.id} empty={text.noTasks} columns={[
          { key: 'name', label: text.name, render: (task) => <button className="link-button" onClick={() => selectTask(task)}>{task.name}</button> },
          { key: 'experiment', label: text.experiments, render: (task) => entries.experiments.find((item) => item.id === task.experimentId)?.name ?? task.experimentId },
          { key: 'kind', label: text.kind, render: (task) => text[task.kind] },
          { key: 'revision', label: text.taskRevision, render: (task) => task.revision },
        ]} />}>
        {selected && <>
          <div className="section-heading"><h2>{selected.name}</h2>
            {canEdit && <div className="task-actions">
              <button className="button small" onClick={() => setDialog({ kind: 'edit', task: selected })}>{text.editTask}</button>
              <button className="button small primary" data-testid="task-launch-run"
                onClick={() => setDialog({ kind: 'launch', task: selected, mode: 'run' })}><Play size={13} />{text.launchRun}</button>
              <button className="button small" data-testid="task-launch-test"
                title={!entries.codeVersions.find((version) => version.id === selected.codeVersionId)?.testEntrypoint?.length ? text.testCommandRequired : undefined}
                disabled={!entries.codeVersions.find((version) => version.id === selected.codeVersionId)?.testEntrypoint?.length}
                onClick={() => setDialog({ kind: 'launch', task: selected, mode: 'test' })}>{text.launchTest}</button>
            </div>}
          </div>
          <TaskDetails task={selected} catalog={entries} targets={computeTargets} />
          <h3>{text.taskHistory}</h3>
          <Resource query={history}>{(historyPage) => <>
            <TaskRunHistory runs={historyPage.items} projectId={project.id} />
            <TaskHistoryPagination cursor={history.cursor} nextCursor={historyPage.nextCursor} loading={history.loading} onChange={history.changeCursor} />
          </>}</Resource>
        </>}
      </RegistryLayout>}</Resource>
      {dialog && dialog.kind !== 'launch' && <TaskEditDialog task={dialog.kind === 'edit' ? dialog.task : undefined}
        experimentId={experimentId || entries.experiments[0]?.id} catalog={entries} targets={computeTargets}
        onClose={() => setDialog(null)} onSaved={(task) => { setDialog(null); reload(); selectTask(task); }} />}
      {dialog?.kind === 'launch' && <TaskLaunchDialog task={dialog.task} initialMode={dialog.mode} catalog={entries} targets={computeTargets}
        onClose={() => setDialog(null)} onSaved={() => { setDialog(null); history.reload(); catalog.reload(); }} />}
    </>}</Resource>}</Resource>
  </section>;
}
