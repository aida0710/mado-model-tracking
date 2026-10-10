import { useState } from 'react';
import type { ServiceAccount } from '@mmt/contracts';
import { accessApi } from '../api/access';
import { useQuery } from '../hooks/useQuery';
import type { SelectOption } from '../types/form';
import { FormFields } from './FormFields';
import { ConfirmDialog } from './ConfirmDialog';
import { ErrorNotice } from './Feedback';
import { withEmptyOption } from '../lib/catalogOptions';
import { getFieldValue } from '../lib/formValues';
import { text } from '../i18n/catalog';

/**
 * Lets a Project admin move an automation rule or a hook to a Service Account, so it keeps
 * starting Jobs after its creator leaves the Project. The caller names who may own it and how.
 */
export function ServiceAccountOwnerTransfer({
  projectId,
  candidates,
  confirmMessage,
  noAccountsMessage,
  transfer,
  onTransferred,
}: {
  projectId: string;
  candidates: (accounts: readonly ServiceAccount[]) => SelectOption[];
  confirmMessage: (accountName: string) => string;
  noAccountsMessage: string;
  transfer: (serviceAccountId: string) => Promise<unknown>;
  onTransferred: () => void;
}) {
  const accounts = useQuery(`${projectId}:service-accounts:owner-transfer`, (signal) =>
    accessApi.serviceAccounts(projectId, signal),
  );
  const [values, setValues] = useState<Record<string, string>>({ serviceAccount: '' });
  const [isConfirming, setIsConfirming] = useState(false);
  const [isTransferred, setIsTransferred] = useState(false);
  const options = candidates(accounts.value ?? []);
  const selectedId = getFieldValue(values, 'serviceAccount');
  const selectedLabel = options.find((option) => option.value === selectedId)?.label ?? selectedId;
  return (
    <section className="automation-owner-transfer">
      <h4>{text.ownerTransfer}</h4>
      <ErrorNotice message={accounts.error} retry={accounts.reload} />
      {accounts.value && !options.length ? (
        <p className="muted">{noAccountsMessage}</p>
      ) : (
        <>
          <FormFields
            fields={[
              {
                name: 'serviceAccount',
                label: text.ownerTransferTarget,
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
            {text.ownerTransfer}
          </button>
        </>
      )}
      {isTransferred && <p className="notice">{text.ownerTransferred}</p>}
      {isConfirming && (
        <ConfirmDialog
          title={text.ownerTransfer}
          message={confirmMessage(selectedLabel)}
          confirmLabel={text.ownerTransfer}
          onConfirm={() => transfer(selectedId)}
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
