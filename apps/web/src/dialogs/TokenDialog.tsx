import { useState } from 'react';
import type { ProjectRole, ServiceAccount, TokenScope, TokenSummary } from '@mmt/contracts';
import { administrationApi } from '../api/administration';
import { useProject } from '../hooks/useProject';
import { FormDialog } from '../components/FormDialog';
import { Dialog } from '../components/Dialog';
import { CopyButton } from '../components/CopyButton';
import { TokenUsageSnippet } from '../components/TokenUsageSnippet';
import { getFieldValue, getSelectedValues } from '../lib/formValues';
import { scopesAllowedForRole } from '../lib/tokenScopes';
import { text } from '../i18n/catalog';
import { serviceAccountsTextTemplates, tokenScopeLabels } from '../i18n/serviceAccounts';

// The API caps lifetimes at MMT_TOKEN_MAX_LIFETIME_DAYS (365 by default); 90 days is offered first
// so a forgotten token does not stay valid for a whole year.
const TOKEN_EXPIRY_PRESET_DAYS = [7, 30, 90, 365];
const DEFAULT_TOKEN_EXPIRY_DAYS = 90;
const DAY_MILLISECONDS = 24 * 60 * 60 * 1000;

type IssuedToken = { token: string; item: TokenSummary };
export type TokenRequest = { name: string; scopes: TokenScope[]; expiresAt: string };

/** A Service Account that receives the token, and how to issue a token to it. */
export interface ServiceAccountTokenOwner {
  serviceAccount: ServiceAccount;
  issue: (request: TokenRequest) => Promise<IssuedToken>;
}

/**
 * Issues a token for the signed-in user, or for a Service Account when `owner` is set.
 * The scopes on offer stop at the owner's Project role, as the API does.
 */
export function TokenDialog({
  owner,
  onClose,
  onCreated,
}: {
  owner?: ServiceAccountTokenOwner;
  onClose: () => void;
  onCreated: () => void;
}) {
  const serviceAccount = owner?.serviceAccount;
  const { project } = useProject();
  const [token, setToken] = useState<string | null>(null);
  const title = serviceAccount
    ? serviceAccountsTextTemplates.serviceAccountTokenTitle(serviceAccount.name)
    : text.newToken;
  if (token)
    return (
      <Dialog title={title} onClose={onClose}>
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
        <TokenUsageSnippet projectId={project.id} token={token} />
        <footer>
          <CopyButton value={token} />
          <button className="button primary" onClick={onClose}>
            {text.close}
          </button>
        </footer>
      </Dialog>
    );
  const ownerRole: ProjectRole = serviceAccount ? (serviceAccount.role ?? 'viewer') : project.role;
  return (
    <FormDialog
      title={title}
      onClose={onClose}
      fields={[
        { name: 'name', label: text.name, required: true },
        {
          name: 'scopes',
          label: text.scopes,
          type: 'multiselect',
          required: true,
          defaultValue: ['read'],
          options: scopesAllowedForRole(ownerRole).map((scope) => ({
            value: scope,
            label: tokenScopeLabels[scope],
          })),
        },
        {
          name: 'expiryDays',
          label: text.expiry,
          type: 'select',
          defaultValue: String(DEFAULT_TOKEN_EXPIRY_DAYS),
          options: TOKEN_EXPIRY_PRESET_DAYS.map((days) => ({
            value: String(days),
            label: serviceAccountsTextTemplates.tokenExpiryDays(days),
          })),
        },
      ]}
      onSubmit={(values) => {
        const scopes = getSelectedValues(values, 'scopes') as TokenScope[];
        if (!scopes.length) throw new Error(text.tokenScopesError);
        const expiryDays = Number(getFieldValue(values, 'expiryDays'));
        const body: TokenRequest = {
          name: getFieldValue(values, 'name'),
          scopes,
          expiresAt: new Date(Date.now() + expiryDays * DAY_MILLISECONDS).toISOString(),
        };
        if (owner) return owner.issue(body);
        return administrationApi.createToken({ ...body, kind: 'personal', projectId: project.id });
      }}
      onSaved={(created) => {
        setToken(created.token);
        onCreated();
      }}
    />
  );
}
