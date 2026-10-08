import { useState } from 'react';
import type { ComputeTarget, ExperimentTask, ExecutionMode } from '@mmt/contracts';
import type { ExecutionCatalog } from '../types/executionCatalog';
import type { FormValues } from '../types/form';
import { tasksApi } from '../api/tasks';
import { buildTaskLaunchInput, createTaskValues, updateTaskValues } from '../lib/taskInput';
import { useMutation } from './useMutation';

export function useTaskLaunchForm({ projectId, task, initialMode, catalog, targets }: {
  projectId: string; task: ExperimentTask; initialMode: ExecutionMode;
  catalog: ExecutionCatalog; targets: ComputeTarget[];
}) {
  const mutation = useMutation();
  const [values, setValues] = useState<FormValues>(() => ({ ...createTaskValues(task), parameters: '{}' }));
  const [mode, setMode] = useState(initialMode);
  function changeValues(next: FormValues) {
    const updated = updateTaskValues({ previous: values, next, catalog, targets });
    setValues({ ...updated, codeVersionId: task.codeVersionId });
    mutation.clearError();
  }
  function launch() {
    return mutation.run(() => tasksApi.launch(projectId, task.id,
      buildTaskLaunchInput({ task, mode, values, catalog, targets })));
  }
  return { ...mutation, values, mode, changeMode: setMode, changeValues, launch };
}
