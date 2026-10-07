import { useState } from 'react';
import { administrationApi } from '../api/administration';
import { useProject } from '../hooks/useProject';
import { FormDialog } from '../components/FormDialog';
import { Dialog } from '../components/Dialog';
import { CopyButton } from '../components/CopyButton';
import { getFieldValue, getSelectedValues } from '../lib/formValues';
import { text } from '../i18n/catalog';

export const TOKEN_SCOPES = [
  'read',
  'runs:write',
  'registry:write',
  'artifacts:write',
  'jobs:write',
  'worker:execute',
  'admin',
];
export function TokenDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const { project, isProjectAdmin, canEdit } = useProject();
  const [token, setToken] = useState<string | null>(null);
  if (token)
    return (
      <Dialog title={text.newToken} onClose={onClose}>
        <p className="notice">{text.tokenOnce}</p>
        <label className="field">
          <span>{text.tokens}</span>
          <input
            className="mono"
            readOnly
            value={token}
            autoComplete="off"
            spellCheck={false}
            onFocus={(event) => event.target.select()}
          />
        </label>

        <footer>
          <CopyButton value={token} />
          <button className="button primary" onClick={onClose}>
            {text.close}
          </button>
        </footer>
      </Dialog>
    );
  return (
    <FormDialog
      title={text.newToken}
      onClose={onClose}
      fields={[
        { name: 'name', label: text.name, required: true },
        {
          name: 'kind',
          label: text.tokenKind,
          type: 'select',
          defaultValue: 'personal',
          options: [
            { value: 'personal', label: text.personal },
            ...(isProjectAdmin ? [{ value: 'service', label: text.service }] : []),
          ],
        },
        {
          name: 'scopes',
          label: text.scopes,
          type: 'multiselect',
          required: true,
          defaultValue: ['read'],
          options: TOKEN_SCOPES.filter(
            (scope) =>
              isProjectAdmin ||
              (canEdit && !['admin', 'worker:execute'].includes(scope)) ||
              scope === 'read',
          ).map((scope) => ({ value: scope, label: scope })),
        },
        { name: 'expiresAt', label: text.expiry, type: 'datetime-local' },
      ]}
      onSubmit={(values) => {
        const scopes = getSelectedValues(values, 'scopes');
        if (!scopes.length) throw new Error(text.tokenScopesError);
        const expiry = getFieldValue(values, 'expiresAt');
        return administrationApi.createToken({
          name: getFieldValue(values, 'name'),
          kind: getFieldValue(values, 'kind') as 'personal' | 'service',
          projectId: project.id,
          scopes,
          expiresAt: expiry ? new Date(expiry).toISOString() : undefined,
        });
      }}
      onSaved={(created) => {
        setToken(created.token);
        onCreated();
      }}
    />
  );
}
