import { useState } from 'react';
import type { PromotionPolicy, ServiceAccount } from '@mmt/contracts';
import { promotionApi } from '../api/promotion';
import { Dialog } from '../components/Dialog';
import { ErrorNotice } from '../components/Feedback';
import { FormFields } from '../components/FormFields';
import { useMutation } from '../hooks/useMutation';
import { getFieldValue, type FormValues } from '../lib/formValues';
import { promotionTextTemplates } from '../i18n/promotion';
import { text } from '../i18n/catalog';

/**
 * Confirms moving a promotion policy's run-as user to a Service Account. Only accounts the API
 * accepts are offered: active ones of this Project with the admin role.
 */
export function PromotionOwnerDialog({
  projectId,
  policy,
  serviceAccounts,
  onClose,
  onSaved,
}: {
  projectId: string;
  policy: PromotionPolicy;
  serviceAccounts: ServiceAccount[];
  onClose: () => void;
  onSaved: (policy: PromotionPolicy) => void;
}) {
  const candidates = serviceAccounts.filter(
    (account) => account.status === 'active' && account.role === 'admin',
  );
  const [values, setValues] = useState<FormValues>({
    serviceAccount:
      candidates.find((account) => account.id === policy.runAsUserId)?.id ??
      candidates[0]?.id ??
      '',
  });
  const [validationError, setValidationError] = useState<string | null>(null);
  const mutation = useMutation();
  return (
    <Dialog fullScreenOnNarrow title={text.promotionTransferOwner} onClose={onClose} busy={mutation.pending}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const serviceAccountId = getFieldValue(values, 'serviceAccount');
          setValidationError(serviceAccountId ? null : text.promotionTransferOwnerRequired);
          if (!serviceAccountId) return;
          void mutation
            .run(() => promotionApi.transferPolicyOwner(projectId, policy.id, serviceAccountId))
            .then((saved) => {
              if (saved) onSaved(saved);
            });
        }}
      >
        <p>{promotionTextTemplates.transferOwnerConfirm(policy.name)}</p>
        <p className="muted">{text.promotionTransferOwnerHint}</p>
        {candidates.length ? (
          <fieldset disabled={mutation.pending}>
            <FormFields
              fields={[
                {
                  name: 'serviceAccount',
                  label: text.promotionTransferOwnerTarget,
                  type: 'select',
                  required: true,
                  options: candidates.map((account) => ({
                    value: account.id,
                    label: account.name,
                  })),
                },
              ]}
              values={values}
              onChange={setValues}
            />
          </fieldset>
        ) : (
          <p className="notice">{text.promotionTransferOwnerNoCandidates}</p>
        )}
        <ErrorNotice message={validationError ?? mutation.error} />
        <footer>
          <button type="button" className="button" onClick={onClose} disabled={mutation.pending}>
            {text.cancel}
          </button>
          <button className="button primary" disabled={mutation.pending || !candidates.length}>
            {mutation.pending ? text.loading : text.promotionTransferOwner}
          </button>
        </footer>
      </form>
    </Dialog>
  );
}
