import type { ModelAliasEvent } from '@mmt/contracts';
import { DataTable } from './DataTable';
import { ErrorNotice } from './Feedback';
import type { ModelAliasHistoryState } from '../hooks/useModelAliasHistory';
import { formatDate } from '../lib/format';
import { modelAliasSourceLabels, modelsText } from '../i18n/models';
import { text } from '../i18n/catalog';

function actorLabel(event: ModelAliasEvent): string {
  if (!event.actor) return modelsText.aliasActorSystem;
  return event.actor.tokenId
    ? `${event.actor.displayName} (${modelsText.aliasActorToken})`
    : event.actor.displayName;
}

const versionLabel = (version: string | null) => version ?? modelsText.aliasUnassigned;

/** Append-only alias changes of one Model, newest first. */
export function ModelAliasHistory({ history }: { history: ModelAliasHistoryState }) {
  return (
    <>
      <h3>{modelsText.aliasHistory}</h3>
      <ErrorNotice message={history.error} retry={history.reload} />
      <DataTable
        items={history.items}
        rowKey={(event) => event.id}
        empty={history.loading ? text.loading : modelsText.aliasHistoryEmpty}
        columns={[
          {
            key: 'createdAt',
            label: modelsText.aliasChangedAt,
            render: (event) => formatDate(event.createdAt),
          },
          { key: 'alias', label: text.alias, className: 'mono', render: (event) => event.alias },
          {
            key: 'versions',
            label: modelsText.aliasVersionChange,
            className: 'mono',
            render: (event) =>
              `${versionLabel(event.previousVersion)} → ${versionLabel(event.version)}`,
          },
          { key: 'actor', label: modelsText.aliasActor, render: actorLabel },
          {
            key: 'source',
            label: modelsText.aliasSource,
            render: (event) => modelAliasSourceLabels[event.source],
          },
          {
            key: 'reason',
            label: modelsText.aliasReason,
            className: 'break-word',
            render: (event) => event.reason || '—',
          },
        ]}
      />
      {history.hasMore && (
        <div className="section-actions">
          <button className="button small" disabled={history.loading} onClick={history.loadMore}>
            {modelsText.aliasHistoryLoadMore}
          </button>
        </div>
      )}
    </>
  );
}
