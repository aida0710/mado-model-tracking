import { useState } from 'react';
import { automationApi } from '../api/automation';
import { useQuery, EXECUTION_POLL_MS } from './useQuery';
import { useMutation } from './useMutation';

export function useModelAutomation(projectId: string, showExecutions: boolean) {
  const rules = useQuery(`${projectId}:automation-rules`, (signal) =>
    automationApi.rules(projectId, signal),
  );
  const executions = useQuery(
    showExecutions ? `${projectId}:automation-executions` : null,
    (signal) => automationApi.executions(projectId, signal),
    EXECUTION_POLL_MS,
  );
  const [selectedRuleId, setSelectedRuleId] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const mutation = useMutation();
  function reload() {
    rules.reload();
    executions.reload();
  }
  async function setEnabled(ruleId: string, enabled: boolean) {
    const saved = await mutation.run(() =>
      automationApi.setRuleEnabled(projectId, ruleId, enabled),
    );
    if (saved) rules.reload();
  }
  return {
    rules,
    executions,
    selectedRuleId,
    selectRule: setSelectedRuleId,
    isCreating,
    startCreating: () => setIsCreating(true),
    stopCreating: () => setIsCreating(false),
    setEnabled,
    reload,
    pending: mutation.pending,
    error: mutation.error,
  };
}
