import { useState } from 'react';
import type { ModelAutomationRule } from '@mmt/contracts';
import { accessApi } from '../api/access';
import { automationApi } from '../api/automation';
import { useQuery } from '../hooks/useQuery';
import { FormFields } from './FormFields';
import { ConfirmDialog } from './ConfirmDialog';
import { ErrorNotice } from './Feedback';
import { withEmptyOption } from '../lib/catalogOptions';
import { getFieldValue } from '../lib/formValues';
import { automationOwnerOptions } from '../lib/automationOwner';
import { automationText } from '../i18n/automation';

/**
 * Lets a Project admin move the rule to a Service Account, so automatic runs continue after the
 * creator leaves the Project.
 */
export function AutomationOwnerTransfer({
  rule,
  projectId,
  onTransferred,
}: {
  rule: ModelAutomationRule;
  projectId: string;
  onTransferred: () => void;
}) {
  const accounts = useQuery(`${projectId}:service-accounts:automation-owner`, (signal) =>
    accessApi.serviceAccounts(projectId, signal),
  );
  const [values, setValues] = useState<Record<string, string>>({ serviceAccount: '' });
  const [isConfirming, setIsConfirming] = useState(false);
  const [isTransferred, setIsTransferred] = useState(false);
  const options = automationOwnerOptions(accounts.value ?? [], rule);
  const selectedId = getFieldValue(values, 'serviceAccount');
  const selectedLabel = options.find((option) => option.value === selectedId)?.label ?? selectedId;
  return (
    <section className="automation-owner-transfer">
      <h4>{automationText.transferOwner}</h4>
      <ErrorNotice message={accounts.error} retry={accounts.reload} />
      {accounts.value && !options.length ? (
        <p className="muted">{automationText.transferNoAccounts}</p>
      ) : (
        <>
          <FormFields
            fields={[
              {
                name: 'serviceAccount',
                label: automationText.transferTarget,
                type: 'select',
                options: withEmptyOption(options),
              },
            ]}
            values={values}
            onChange={(next) => {
              setValues({ serviceAccount: getFieldValue(next, 'serviceAccount') });
              setIsTransferred(false);
            }}
          />
          <button
            className="button small"
            disabled={!selectedId}
            onClick={() => setIsConfirming(true)}
          >
            {automationText.transferOwner}
          </button>
        </>
      )}
      {isTransferred && <p className="notice">{automationText.transferred}</p>}
      {isConfirming && (
        <ConfirmDialog
          title={automationText.transferOwner}
          message={automationText.transferConfirmMessage(rule.name, selectedLabel)}
          confirmLabel={automationText.transferOwner}
          onConfirm={() =>
            automationApi.transferOwner(projectId, rule.id, { serviceAccountId: selectedId })
          }
          onConfirmed={() => {
            setIsConfirming(false);
            setIsTransferred(true);
            setValues({ serviceAccount: '' });
            onTransferred();
          }}
          onClose={() => setIsConfirming(false)}
        />
      )}
    </section>
  );
}
