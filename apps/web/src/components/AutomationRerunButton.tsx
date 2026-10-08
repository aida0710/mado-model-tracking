import { useState } from 'react';
import type { ModelAutomationExecution, ModelAutomationRule } from '@mmt/contracts';
import { automationApi } from '../api/automation';
import { ConfirmDialog } from './ConfirmDialog';
import { manualExecutionErrorMessage } from '../lib/automationManualExecution';
import { rerunRequest } from '../lib/automationRerun';
import { automationText } from '../i18n/automation';

/** Applies an execution's rule again to the same version (or upstream Run); Project admin only. */
export function AutomationRerunButton({
  execution,
  rule,
  projectId,
  onRerun,
}: {
  execution: ModelAutomationExecution;
  rule: ModelAutomationRule;
  projectId: string;
  onRerun: () => void;
}) {
  const [isConfirming, setIsConfirming] = useState(false);
  return (
    <>
      <button className="button small" onClick={() => setIsConfirming(true)}>
        {automationText.rerun}
      </button>
      {isConfirming && (
        <ConfirmDialog
          title={automationText.rerun}
          message={automationText.rerunConfirmMessage(rule.name)}
          confirmLabel={automationText.rerun}
          onConfirm={() =>
            automationApi
              .createExecution(projectId, rule.id, rerunRequest(execution, rule))
              .catch((failure: unknown) => {
                throw new Error(manualExecutionErrorMessage(failure));
              })
          }
          onConfirmed={() => {
            setIsConfirming(false);
            onRerun();
          }}
          onClose={() => setIsConfirming(false)}
        />
      )}
    </>
  );
}
