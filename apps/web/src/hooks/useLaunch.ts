import { useState } from 'react';
import type { Job, Run } from '@mmt/contracts';
import type { CreateJob, CreateRun } from '../api/inputs';
import { trackingApi } from '../api/tracking';
import { executionApi } from '../api/execution';
import { useMutation } from './useMutation';

export function useLaunch(projectId: string, existingRun?: Run) {
  const [savedRun, setSavedRun] = useState<Run | undefined>(existingRun);
  const mutation = useMutation();
  async function launch(input: {
    run: CreateRun;
    job: Omit<CreateJob, 'runId'>;
  }): Promise<Job | undefined> {
    return mutation.run(async () => {
      const run = savedRun ?? (await trackingApi.createRun(projectId, input.run));
      // Preserve a successfully registered Run when enqueueing fails; retry must not create another Run.
      setSavedRun(run);
      return executionApi.createJob(projectId, { ...input.job, runId: run.id });
    });
  }
  return { ...mutation, savedRun, launch };
}
