import { useState } from 'react';
import type { HookCreated } from '@mmt/contracts';
import { hooksApi } from '../api/hooks';
import type { FormValues } from '../types/form';
import type { HookCatalog } from '../types/hooks';
import { buildHookInput, createHookValues, updateHookValues } from '../lib/hookInput';
import { useMutation } from './useMutation';

export function useHookForm({ projectId, catalog }: { projectId: string; catalog: HookCatalog }) {
  const [values, setValues] = useState(createHookValues);
  const mutation = useMutation();
  function changeValues(next: FormValues) {
    setValues((previous) => updateHookValues({ previous, next, catalog }));
    mutation.clearError();
  }
  function save(): Promise<HookCreated | undefined> {
    return mutation.run(() => hooksApi.create(projectId, buildHookInput(values, catalog)));
  }
  return { ...mutation, values, changeValues, save };
}
