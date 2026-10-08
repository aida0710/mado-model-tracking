import { RefreshCw } from 'lucide-react';
import { administrationApi } from '../api/administration';
import { useProject } from '../hooks/useProject';
import { useQuery } from '../hooks/useQuery';
import { parsePrometheus } from '../lib/prometheus';
import {
  buildStorageMetrics,
  type StorageBucketMetrics,
  type StorageConnectionMetrics,
} from '../lib/storageMetrics';
import { ResponsiveTable, type ResponsiveTableColumn } from './ResponsiveTable';
import { Empty, ErrorNotice, Resource } from './Feedback';
import { StorageMetricValue } from './StorageMetricValue';
import { text } from '../i18n/catalog';

type StorageMeasurementFields = Pick<
  StorageBucketMetrics,
  'bytes' | 'objects' | 'ageSeconds' | 'failures'
>;
const metricColumnDefinitions = {
  bytes: { label: text.capacity, unit: 'bytes' },
  objects: { label: text.objects, unit: 'count' },
  ageSeconds: { label: text.collectionAge, unit: 'seconds' },
  failures: { label: text.collectionFailures, unit: 'count' },
} as const;

function createStorageMetricColumns<T extends StorageMeasurementFields>(
  fields: Array<keyof StorageMeasurementFields>,
): ResponsiveTableColumn<T>[] {
  return fields.map((field) => ({
    key: field,
    // Capacity is what the panel is for; the other measurements wait for the row to open.
    priority: field === 'bytes' ? 'primary' : 'secondary',
    header: metricColumnDefinitions[field].label,
    className: 'mono numeric nowrap',
    render: (item) => (
      <StorageMetricValue sample={item[field]} unit={metricColumnDefinitions[field].unit} />
    ),
  }));
}

function ConnectionStorageMetrics({ connection }: { connection: StorageConnectionMetrics }) {
  const prefixes = connection.buckets.flatMap((bucket) =>
    bucket.prefixes.map((prefix) => ({ ...prefix, bucket: bucket.bucket })),
  );
  const tracking = connection.trackingEnabled?.value;
  return (
    <section className="storage-connection">
      <h3 title={connection.connectionId}>
        {connection.connectionName ?? connection.connectionId}
      </h3>
      {connection.connectionName && <p className="muted mono">{connection.connectionId}</p>}
      <div className="storage-tracking">
        <span>
          {text.capacityTracking}:{' '}
          {tracking === 1 ? text.enabled : tracking === 0 ? text.disabled : text.unknownMetric}
        </span>
        <span>
          {text.collectionInterval}:{' '}
          <StorageMetricValue sample={connection.intervalSeconds} unit="seconds" />
        </span>
      </div>
      {!!connection.buckets.length && (
        <ResponsiveTable
          rows={connection.buckets}
          rowKey={(bucket) => bucket.bucket}
          columns={[
            {
              key: 'bucket',
              priority: 'primary',
              header: text.bucket,
              className: 'mono storage-label',
              render: (bucket) => bucket.bucket,
            },
            ...createStorageMetricColumns<StorageBucketMetrics>([
              'bytes',
              'objects',
              'ageSeconds',
              'failures',
            ]),
          ]}
        />
      )}
      {!!prefixes.length && (
        <div className="storage-prefixes">
          <h4>{text.prefix}</h4>
          <ResponsiveTable
            rows={prefixes}
            rowKey={(prefix) => JSON.stringify([prefix.bucket, prefix.prefix])}
            columns={[
              {
                key: 'bucket',
                priority: 'primary',
                header: text.bucket,
                className: 'mono storage-label',
                render: (prefix) => prefix.bucket,
              },
              {
                key: 'prefix',
                priority: 'primary',
                header: text.prefix,
                className: 'mono storage-label',
                render: (prefix) => prefix.prefix,
              },
              ...createStorageMetricColumns<(typeof prefixes)[number]>(['bytes', 'objects']),
            ]}
          />
        </div>
      )}
    </section>
  );
}

export function PluginStorageMetrics({ pluginId }: { pluginId: string }) {
  const { project } = useProject();
  const metrics = useQuery(`${project.id}:plugin:${pluginId}:metrics`, (signal) =>
    administrationApi.pluginMetrics(project.id, pluginId, signal),
  );
  return (
    <section className="storage-metrics" aria-label={text.storageMetrics}>
      <div className="section-heading">
        <h2>{text.storageMetrics}</h2>
        <button
          className="icon-button"
          aria-label={text.refreshMetrics}
          disabled={metrics.loading}
          onClick={metrics.reload}
        >
          <RefreshCw size={16} />
        </button>
      </div>
      <Resource query={metrics}>
        {(prometheus) => {
          const parsed = parsePrometheus(prometheus);
          const connections = buildStorageMetrics(parsed.samples);
          return (
            <>
              <ErrorNotice
                message={
                  parsed.invalidLineNumbers.length
                    ? `${text.metricsParseErrors}: ${parsed.invalidLineNumbers.join(', ')}`
                    : null
                }
              />
              {connections.length ? (
                connections.map((connection) => (
                  <ConnectionStorageMetrics key={connection.connectionId} connection={connection} />
                ))
              ) : (
                <Empty>{text.noStorageMetrics}</Empty>
              )}
              <details className="raw-metrics">
                <summary>{text.rawPrometheus}</summary>
                <pre className="artifact-text">{prometheus || text.empty}</pre>
              </details>
            </>
          );
        }}
      </Resource>
    </section>
  );
}
