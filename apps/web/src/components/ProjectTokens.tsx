import { useState } from 'react';
import type { TokenSummary } from '@mmt/contracts';
import { administrationApi } from '../api/administration';
import { useProject } from '../hooks/useProject';
import { useQuery, type QueryState } from '../hooks/useQuery';
import { ResponsiveTable, type ResponsiveTableColumn } from './ResponsiveTable';
import { Resource } from './Feedback';
import { ConfirmDialog } from './ConfirmDialog';
import { TokenDialog } from '../dialogs/TokenDialog';
import { formatDate } from '../lib/format';
import { text, textTemplates } from '../i18n/catalog';

/**
 * The signed-in user's tokens and, for Project admins, every token limited to the Project.
 * `projectTokens` is shared with the Service Account section so issuing a key shows up here.
 */
export function ProjectTokens({ projectTokens }: { projectTokens: QueryState<TokenSummary[]> }) {
  const { project, isProjectAdmin } = useProject();
  const personalTokens = useQuery('personal-tokens', administrationApi.tokens);
  const [showCreate, setShowCreate] = useState(false);
  const [revokingToken, setRevokingToken] = useState<TokenSummary | null>(null);
  const reloadAll = () => {
    personalTokens.reload();
    if (isProjectAdmin) projectTokens.reload();
  };
  const revokeColumn: ResponsiveTableColumn<TokenSummary> = {
    key: 'revoke',
    priority: 'secondary',
    header: text.revoke,
    render: (item) => (
      <button className="button small danger" onClick={() => setRevokingToken(item)}>
        {text.revoke}
      </button>
    ),
  };
  return (
    <>
      <section className="settings-section">
        <div className="section-heading">
          <h2>{text.personalTokens}</h2>
          <button className="button small" onClick={() => setShowCreate(true)}>
            {text.newToken}
          </button>
        </div>
        <Resource query={personalTokens}>
          {(items) => (
            <ResponsiveTable
              rows={items.filter(
                (item) => item.projectId === project.id || item.projectId === null,
              )}
              rowKey={(item) => item.id}
              columns={[...tokenColumns(), revokeColumn]}
            />
          )}
        </Resource>
      </section>
      {isProjectAdmin && (
        <section className="settings-section">
          <div className="section-heading">
            <h2>{text.projectTokens}</h2>
          </div>
          <p className="muted">{text.projectTokensDescription}</p>
          <Resource query={projectTokens}>
            {(items) => (
              <ResponsiveTable
                rows={items}
                rowKey={(item) => item.id}
                empty={text.projectTokensEmpty}
                columns={[...tokenColumns({ withOwner: true }), revokeColumn]}
              />
            )}
          </Resource>
        </section>
      )}
      {showCreate && <TokenDialog onClose={() => setShowCreate(false)} onCreated={reloadAll} />}
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
            reloadAll();
          }}
        />
      )}
    </>
  );
}

function tokenColumns({ withOwner = false } = {}): ResponsiveTableColumn<TokenSummary>[] {
  return [
    {
      key: 'name',
      priority: 'primary',
      header: text.name,
      render: (item) => (
        <>
          {item.name}
          {item.legacy && (
            <span className="muted" title={text.legacyTokenHint}>
              {' '}
              ({text.legacyToken})
            </span>
          )}
        </>
      ),
    },
    ...(withOwner
      ? [
          {
            key: 'owner',
            priority: 'secondary' as const,
            header: text.tokenOwner,
            render: (item: TokenSummary) =>
              `${item.ownerName} (${
                item.ownerType === 'service_account'
                  ? text.tokenOwnerServiceAccount
                  : text.tokenOwnerUser
              })`,
          },
        ]
      : []),
    {
      key: 'prefix',
      priority: 'secondary',
      header: text.tokenPrefix,
      className: 'mono',
      render: (item) => (item.tokenPrefix ? `${item.tokenPrefix}…` : '—'),
    },
    {
      key: 'scopes',
      priority: 'secondary',
      header: text.scopes,
      className: 'mono',
      render: (item) => item.scopes.join(', '),
    },
    {
      key: 'expires',
      priority: 'primary',
      header: text.expiry,
      render: (item) => (item.expiresAt ? formatDate(item.expiresAt) : text.noExpiry),
    },
    {
      key: 'lastUsed',
      priority: 'secondary',
      header: text.lastUsed,
      render: (item) => formatDate(item.lastUsedAt),
    },
  ];
}
