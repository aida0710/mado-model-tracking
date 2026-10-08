import { useState } from 'react';
import type { Account, TokenSummary } from '@mmt/contracts';
import { administrationApi } from '../api/administration';
import { useAccount } from '../hooks/useAccount';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { DataTable } from '../components/DataTable';
import { Resource } from '../components/Feedback';
import { PageHeader } from '../components/PageHeader';
import { PasswordChangeForm } from '../components/PasswordChangeForm';
import { formatDate } from '../lib/format';
import { isSsoUser, userAuthSourceLabels } from '../lib/adminUserDisplay';
import { canChangeOwnPassword } from '../lib/permissions';
import { text, textTemplates } from '../i18n/catalog';

function AccountProfile({ account }: { account: Account }) {
  const { user } = account;
  return (
    <section className="account-section">
      <h2>{text.accountProfile}</h2>
      <dl className="details-list">
        <div>
          <dt>{text.displayName}</dt>
          <dd>{user.displayName}</dd>
        </div>
        {user.username && (
          <div>
            <dt>{text.username}</dt>
            <dd className="mono">{user.username}</dd>
          </div>
        )}
        <div>
          <dt>{text.email}</dt>
          <dd>{user.email || '—'}</dd>
        </div>
        <div>
          <dt>{text.userAuthSources}</dt>
          <dd>{userAuthSourceLabels(user).join(' / ')}</dd>
        </div>
        <div>
          <dt>{text.userGlobalAdmin}</dt>
          <dd>{user.isAdmin ? text.userIsAdmin : text.userIsNotAdmin}</dd>
        </div>
      </dl>
    </section>
  );
}

function AccountGroups({ account }: { account: Account }) {
  return (
    <section className="account-section">
      <h2>{text.accountGroups}</h2>
      {account.groups.length === 0 ? (
        <p className="muted">{text.accountNoGroups}</p>
      ) : (
        <ul className="account-groups">
          {account.groups.map((group) => (
            <li key={group} className="mono">
              {group}
            </li>
          ))}
        </ul>
      )}
      <p className="muted">
        {text.accountGroupsSso}
        {account.groupsSyncedAt &&
          ` ${textTemplates.groupsSyncedAt(formatDate(account.groupsSyncedAt))}`}
      </p>
    </section>
  );
}

function AccountTokens({
  tokens,
  projectNames,
  onRevoke,
}: {
  tokens: TokenSummary[];
  projectNames: Map<string, string>;
  onRevoke: (token: TokenSummary) => void;
}) {
  return (
    <DataTable
      items={tokens}
      rowKey={(token) => token.id}
      columns={[
        { key: 'name', label: text.name, render: (token) => token.name },
        {
          key: 'project',
          label: text.accountTokenProject,
          render: (token) =>
            token.projectId
              ? (projectNames.get(token.projectId) ?? token.projectId)
              : text.accountTokenAllProjects,
        },
        {
          key: 'scopes',
          label: text.scopes,
          className: 'mono',
          render: (token) => token.scopes.join(', '),
        },
        {
          key: 'expires',
          label: text.expiry,
          render: (token) => (token.expiresAt ? formatDate(token.expiresAt) : text.noExpiry),
        },
        { key: 'lastUsed', label: text.lastUsed, render: (token) => formatDate(token.lastUsedAt) },
        {
          key: 'revoke',
          label: text.revoke,
          render: (token) => (
            <button className="button small danger" onClick={() => onRevoke(token)}>
              {text.revoke}
            </button>
          ),
        },
      ]}
    />
  );
}

/** The signed-in user's own account: profile, SSO groups, password and API tokens (/account). */
export function AccountPage() {
  const { account, tokens, projectNames } = useAccount();
  const [revokingToken, setRevokingToken] = useState<TokenSummary | null>(null);
  return (
    <>
      <PageHeader title={text.account} />
      <Resource query={account}>
        {(value) => (
          <div className="account-page">
            <AccountProfile account={value} />
            {isSsoUser(value.user) && <AccountGroups account={value} />}
            {canChangeOwnPassword(value.user) && (
              <section className="account-section">
                <h2>{text.accountPassword}</h2>
                <PasswordChangeForm />
              </section>
            )}
            <section className="account-section">
              <h2>{text.accountTokens}</h2>
              <Resource query={tokens}>
                {(items) => (
                  <AccountTokens
                    tokens={items}
                    projectNames={projectNames}
                    onRevoke={setRevokingToken}
                  />
                )}
              </Resource>
            </section>
          </div>
        )}
      </Resource>
      {revokingToken && (
        <ConfirmDialog
          title={text.revokeToken}
          message={textTemplates.revokeTokenConfirm(revokingToken.name)}
          confirmLabel={text.revoke}
          destructive
          onClose={() => setRevokingToken(null)}
          onConfirm={() => administrationApi.revokeToken(revokingToken.id)}
          onConfirmed={() => {
            setRevokingToken(null);
            tokens.reload();
          }}
        />
      )}
    </>
  );
}
