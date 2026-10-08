import { useState } from 'react';
import type { CodeVersion, ComputeTarget, ExperimentTask } from '@mmt/contracts';
import type { ExecutionCatalog } from '../types/executionCatalog';
import type { FormValues } from '../types/form';
import { tasksApi } from '../api/tasks';
import { buildTaskInput, createTaskValues, updateTaskValues } from '../lib/taskInput';
import { useMutation } from './useMutation';

export function useTaskForm({ projectId, task, experimentId, catalog, targets }: {
  projectId: string; task?: ExperimentTask; experimentId?: string;
  catalog: ExecutionCatalog; targets: ComputeTarget[];
}) {
  const [values, setValues] = useState(() => createTaskValues(task, experimentId));
  const [savedCodeVersions, setSavedCodeVersions] = useState<CodeVersion[]>([]);
  const mutation = useMutation();
  const currentCatalog = { ...catalog, codeVersions: [...new Map([
    ...catalog.codeVersions, ...savedCodeVersions,
  ].map((version) => [version.id, version])).values()] };
  function changeValues(next: FormValues) {
    setValues(updateTaskValues({ previous: values, next, catalog: currentCatalog, targets }));
    mutation.clearError();
  }
  function selectSavedCodeVersion(version: CodeVersion) {
    setSavedCodeVersions((previous) => [...previous, version]);
    setValues((previous) => updateTaskValues({ previous, next: { ...previous, codeVersionId: version.id },
      catalog: { ...currentCatalog, codeVersions: [...currentCatalog.codeVersions, version] }, targets }));
    mutation.clearError();
  }
  function save() {
    return mutation.run(() => {
      const input = buildTaskInput({ values, catalog: currentCatalog, targets });
      if (!task) return tasksApi.create(projectId, input);
      const { experimentId: _experimentId, ...changes } = input;
      return tasksApi.update(projectId, task.id, { ...changes, expectedRevision: task.revision });
    });
  }
  return { ...mutation, values, changeValues, selectSavedCodeVersion, catalog: currentCatalog, save };
}
