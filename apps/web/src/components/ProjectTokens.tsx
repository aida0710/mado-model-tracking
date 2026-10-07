import { useState } from 'react';
import { administrationApi } from '../api/administration';
import { useProject } from '../hooks/useProject';
import { useQuery } from '../hooks/useQuery';
import { DataTable } from './DataTable';
import { Resource } from './Feedback';
import { FormDialog } from './FormDialog';
import { TokenDialog } from '../dialogs/TokenDialog';
import { formatDate } from '../lib/format';
import { text } from '../i18n/catalog';

export function ProjectTokens() {
  const { project } = useProject();
  const tokens = useQuery('personal-tokens', administrationApi.tokens);
  const [showCreate, setShowCreate] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  return (
    <section className="settings-section">
      <div className="section-heading">
        <h2>{text.tokens}</h2>
        <button className="button small" onClick={() => setShowCreate(true)}>
          {text.newToken}
        </button>
      </div>
      <Resource query={tokens}>
        {(items) => (
          <DataTable
            items={items.filter((item) => item.projectId === project.id || item.projectId === null)}
            rowKey={(item) => item.id}
            columns={[
              { key: 'name', label: text.name, render: (item) => item.name },
              { key: 'kind', label: text.tokenKind, render: (item) => text[item.kind] },
              {
                key: 'scopes',
                label: text.scopes,
                className: 'mono',
                render: (item) => item.scopes.join(', '),
              },
              {
                key: 'expires',
                label: text.expiry,
                render: (item) => (item.expiresAt ? formatDate(item.expiresAt) : text.noExpiry),
              },
              {
                key: 'lastUsed',
                label: text.lastUsed,
                render: (item) => formatDate(item.lastUsedAt),
              },
              {
                key: 'revoke',
                label: text.revoke,
                render: (item) => (
                  <button className="button small danger" onClick={() => setRevokingId(item.id)}>
                    {text.revoke}
                  </button>
                ),
              },
            ]}
          />
        )}
      </Resource>
      {showCreate && <TokenDialog onClose={() => setShowCreate(false)} onCreated={tokens.reload} />}
      {revokingId && (
        <FormDialog
          title={text.revokeToken}
          onClose={() => setRevokingId(null)}
          fields={[]}
          onSubmit={() => administrationApi.revokeToken(revokingId)}
          onSaved={() => {
            setRevokingId(null);
            tokens.reload();
          }}
        />
      )}
    </section>
  );
}
