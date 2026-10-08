import { useState } from 'react';
import type { Run } from '@mmt/contracts';
import { tasksApi } from '../api/tasks';
import { hasOutputModel } from '../lib/taskInput';
import { getRunOutputRegistrationState, isTerminalRun } from '../lib/runOutputRegistrationState';
import { EXECUTION_POLL_MS, useQuery } from './useQuery';

/**
 * The outcome exists only after the Run ends, so it is fetched from then on and polled until the
 * API records it for a Run that carries a launch-time output setting.
 */
export function useRunOutputRegistration(run: Run) {
  const [hasOutcome, setHasOutcome] = useState(false);
  const isExpected = !!run.outputModelRegistration && !hasOutcome;
  const query = useQuery(
    hasOutputModel(run.kind) && isTerminalRun(run) ? `${run.projectId}:${run.id}:output-registration` : null,
    async (signal) => {
      const registration = await tasksApi.runOutputRegistration(run.projectId, run.id, signal);
      if (registration) setHasOutcome(true);
      return registration;
    },
    isExpected ? EXECUTION_POLL_MS : undefined,
  );
  return { state: getRunOutputRegistrationState(run, query.value), error: query.error };
}
