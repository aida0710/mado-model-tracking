import { useState } from 'react';
import type { ModelAutomationRule } from '@mmt/contracts';
import { automationApi } from '../api/automation';
import type { AutomationCatalog } from '../types/modelAutomation';
import type { FormValues } from '../types/form';
import {
  buildAutomationRuleInput,
  createAutomationValues,
  updateAutomationValues,
} from '../lib/modelAutomationInput';
import { useMutation } from './useMutation';

export function useAutomationRuleForm({
  projectId,
  catalog,
  initialFamilies,
}: {
  projectId: string;
  catalog: AutomationCatalog;
  initialFamilies: string[];
}) {
  const [values, setValues] = useState(() => createAutomationValues(initialFamilies));
  const mutation = useMutation();
  function changeValues(next: FormValues) {
    setValues((previous) => updateAutomationValues({ previous, next, catalog }));
    mutation.clearError();
  }
  function save(): Promise<ModelAutomationRule | undefined> {
    return mutation.run(() =>
      automationApi.createRule(projectId, buildAutomationRuleInput(values, catalog)),
    );
  }
  return { ...mutation, values, changeValues, save };
}
