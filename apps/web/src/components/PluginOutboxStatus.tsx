import type { PluginOutboxSummary } from '@mmt/contracts';
import type { QueryState } from '../hooks/useQuery';
import { formatDate } from '../lib/format';
import { DetailsList } from './JsonDetails';
import { Resource } from './Feedback';
import { text } from '../i18n/catalog';

/** Undelivered plugin events: counts, the oldest one, and the latest failure code. */
export function PluginOutboxStatus({ summary }: { summary: QueryState<PluginOutboxSummary> }) {
  return (
    <section className="plugin-outbox" data-testid="plugin-outbox">
      <h3>{text.pluginOutbox}</h3>
      <Resource query={summary}>
        {(outbox) => (
          <>
            {outbox.stalled && (
              <p className="notice error" role="status">
                {text.pluginOutboxStalled}
              </p>
            )}
            <DetailsList
              entries={[
                [text.pluginOutboxPending, outbox.pending],
                [text.pluginOutboxSending, outbox.sending],
                [text.pluginOutboxOldestPending, formatDate(outbox.oldestPendingAt)],
                [text.pluginOutboxMaxAttempts, outbox.maxAttempts],
                [text.pluginOutboxLastError, outbox.lastError && <code>{outbox.lastError}</code>],
                [text.pluginOutboxLastDelivered, formatDate(outbox.lastDeliveredAt)],
              ]}
            />
          </>
        )}
      </Resource>
    </section>
  );
}
