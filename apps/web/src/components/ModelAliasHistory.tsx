import type { ModelAliasEvent } from '@mmt/contracts';
import { ResponsiveTable } from './ResponsiveTable';
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
      <ResponsiveTable
        rows={history.items}
        rowKey={(event) => event.id}
        empty={history.loading ? text.loading : modelsText.aliasHistoryEmpty}
        columns={[
          {
            key: 'createdAt',
            priority: 'primary',
            header: modelsText.aliasChangedAt,
            render: (event) => formatDate(event.createdAt),
          },
          { key: 'alias', priority: 'primary', header: text.alias, className: 'mono', render: (event) => event.alias },
          {
            key: 'versions',
            priority: 'primary',
            header: modelsText.aliasVersionChange,
            className: 'mono',
            render: (event) =>
              `${versionLabel(event.previousVersion)} → ${versionLabel(event.version)}`,
          },
          { key: 'actor', priority: 'secondary', header: modelsText.aliasActor, render: actorLabel },
          {
            key: 'source',
            priority: 'secondary',
            header: modelsText.aliasSource,
            render: (event) => modelAliasSourceLabels[event.source],
          },
          {
            key: 'reason',
            priority: 'secondary',
            header: modelsText.aliasReason,
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
