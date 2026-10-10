import { useState } from 'react';
import type { ComputeTargetDetails } from '@mmt/contracts';
import { executionApi } from '../api/execution';
import { siteComputersApi } from '../api/siteComputers';
import type { FormValues } from '../types/form';
import {
  buildTargetCreate,
  buildTargetInput,
  changedTargetSharing,
  newTargetFormValues,
  targetFormValues,
  updateTargetValues,
  type TargetOwnership,
} from '../lib/targetInput';
import { useMutation } from './useMutation';

/**
 * The target dialog's values and save. An edit of an owned computer saves the target first and
 * then, if they changed, the Projects it is shared with (a separate PUT).
 */
export function useTargetForm({
  target,
  newOwnership,
}: {
  target?: ComputeTargetDetails;
  newOwnership: TargetOwnership;
}) {
  const [values, setValues] = useState(() =>
    target ? targetFormValues(target) : newTargetFormValues(newOwnership),
  );
  const mutation = useMutation();
  function changeValues(next: FormValues) {
    setValues((previous) => updateTargetValues(previous, next));
    mutation.clearError();
  }
  function save(): Promise<ComputeTargetDetails | undefined> {
    return mutation.run(async () => {
      if (!target) return executionApi.createTarget(buildTargetCreate(values));
      const input = buildTargetInput(values, target);
      const projectIds = changedTargetSharing(values, target);
      const saved = await executionApi.updateTarget(target.id, input);
      return projectIds ? siteComputersApi.setProjects(target.id, { projectIds }) : saved;
    });
  }
  return { ...mutation, values, changeValues, save };
}
