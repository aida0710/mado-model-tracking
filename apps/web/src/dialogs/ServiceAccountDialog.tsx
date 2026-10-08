import type { ProjectRole, ServiceAccount, ServiceAccountCreate } from '@mmt/contracts';
import { FormDialog } from '../components/FormDialog';
import { getFieldValue } from '../lib/formValues';
import { text } from '../i18n/catalog';

const PROJECT_ROLES: ProjectRole[] = ['viewer', 'editor', 'admin'];

/**
 * Creates a Service Account, or changes the description and role of an existing one.
 * The name identifies the account in the token list, so it is fixed after creation.
 */
export function ServiceAccountDialog({
  serviceAccount,
  onSave,
  onSaved,
  onClose,
}: {
  serviceAccount?: ServiceAccount;
  onSave: (account: ServiceAccountCreate) => Promise<unknown>;
  onSaved: () => void;
  onClose: () => void;
}) {
  return (
    <FormDialog
      title={serviceAccount ? text.editServiceAccount : text.newServiceAccount}
      onClose={onClose}
      fields={[
        {
          name: 'name',
          label: text.name,
          required: true,
          maxLength: 200,
          defaultValue: serviceAccount?.name ?? '',
          readOnly: !!serviceAccount,
        },
        {
          name: 'description',
          label: text.description,
          type: 'textarea',
          maxLength: 2000,
          defaultValue: serviceAccount?.description ?? '',
        },
        {
          name: 'role',
          label: text.role,
          type: 'select',
          defaultValue: serviceAccount?.role ?? 'editor',
          options: PROJECT_ROLES.map((role) => ({ value: role, label: text[role] })),
        },
      ]}
      onSubmit={(values) =>
        onSave({
          name: getFieldValue(values, 'name'),
          description: getFieldValue(values, 'description'),
          role: getFieldValue(values, 'role') as ProjectRole,
        })
      }
      onSaved={onSaved}
    />
  );
}
