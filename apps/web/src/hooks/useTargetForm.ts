import { useState } from 'react';
import type { ComputeTargetDetails } from '@mmt/contracts';
import { executionApi } from '../api/execution';
import type { FormValues } from '../types/form';
import {
  buildTargetCreate,
  buildTargetInput,
  newTargetFormValues,
  targetFormValues,
  updateTargetValues,
} from '../lib/targetInput';
import { useMutation } from './useMutation';

/** The target dialog's values and save: POST for a new computer, PATCH for an edited one. */
export function useTargetForm({
  target,
  canAddSshOrLocal,
}: {
  target?: ComputeTargetDetails;
  /** Whether a new computer starts as an ssh target (global administrators) or a site. */
  canAddSshOrLocal: boolean;
}) {
  const [values, setValues] = useState(() =>
    target ? targetFormValues(target) : newTargetFormValues({ canAddSshOrLocal }),
  );
  const mutation = useMutation();
  function changeValues(next: FormValues) {
    setValues((previous) => updateTargetValues(previous, next));
    mutation.clearError();
  }
  function save(): Promise<ComputeTargetDetails | undefined> {
    return mutation.run(() =>
      target
        ? executionApi.updateTarget(target.id, buildTargetInput(values, target))
        : executionApi.createTarget(buildTargetCreate(values)),
    );
  }
  return { ...mutation, values, changeValues, save };
}
