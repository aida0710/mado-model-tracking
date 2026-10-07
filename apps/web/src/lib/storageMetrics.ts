import type { PrometheusSample } from './prometheus';

export interface StoragePrefixMetrics {
  prefix: string;
  bytes?: PrometheusSample;
  objects?: PrometheusSample;
}

export interface StorageBucketMetrics {
  bucket: string;
  bytes?: PrometheusSample;
  objects?: PrometheusSample;
  ageSeconds?: PrometheusSample;
  failures?: PrometheusSample;
  prefixes: StoragePrefixMetrics[];
}

export interface StorageConnectionMetrics {
  connectionId: string;
  connectionName?: string;
  trackingEnabled?: PrometheusSample;
  intervalSeconds?: PrometheusSample;
  buckets: StorageBucketMetrics[];
}

const bucketMetricFields = {
  mado_storage_bucket_bytes: 'bytes',
  mado_storage_bucket_objects: 'objects',
  mado_storage_capacity_collection_age_seconds: 'ageSeconds',
  mado_storage_capacity_collection_failures: 'failures',
} as const;
const prefixMetricFields = {
  mado_storage_prefix_bytes: 'bytes',
  mado_storage_prefix_objects: 'objects',
} as const;
const connectionMetricNames = new Set([
  'mado_storage_connection_info',
  'mado_storage_capacity_tracking_enabled',
  'mado_storage_capacity_tracking_interval_seconds',
]);

export function buildStorageMetrics(samples: PrometheusSample[]): StorageConnectionMetrics[] {
  const connections = new Map<string, StorageConnectionMetrics>();
  for (const sample of samples) {
    const connectionId = sample.labels.connection_id;
    if (!connectionId) continue;
    if (
      !connectionMetricNames.has(sample.name) &&
      !Object.hasOwn(bucketMetricFields, sample.name) &&
      !Object.hasOwn(prefixMetricFields, sample.name)
    )
      continue;
    const connection: StorageConnectionMetrics = connections.get(connectionId) ?? {
      connectionId,
      buckets: [],
    };
    connections.set(connectionId, connection);
    if (sample.name === 'mado_storage_connection_info') {
      if (sample.value === 1) connection.connectionName = sample.labels.connection_name;
      continue;
    }
    if (sample.name === 'mado_storage_capacity_tracking_enabled') {
      connection.trackingEnabled = sample;
      continue;
    }
    if (sample.name === 'mado_storage_capacity_tracking_interval_seconds') {
      connection.intervalSeconds = sample;
      continue;
    }
    const bucketName = sample.labels.bucket;
    if (bucketName === undefined) continue;
    const bucket: StorageBucketMetrics = connection.buckets.find(
      (item) => item.bucket === bucketName,
    ) ?? {
      bucket: bucketName,
      prefixes: [],
    };
    if (!connection.buckets.includes(bucket)) connection.buckets.push(bucket);
    if (Object.hasOwn(bucketMetricFields, sample.name)) {
      const field = bucketMetricFields[sample.name as keyof typeof bucketMetricFields];
      bucket[field] = sample;
      continue;
    }
    const prefixName = sample.labels.prefix;
    if (prefixName === undefined) continue;
    const prefix: StoragePrefixMetrics = bucket.prefixes.find(
      (item) => item.prefix === prefixName,
    ) ?? { prefix: prefixName };
    if (!bucket.prefixes.includes(prefix)) bucket.prefixes.push(prefix);
    const field = prefixMetricFields[sample.name as keyof typeof prefixMetricFields];
    prefix[field] = sample;
  }
  // Prefix samples are a partial top-level listing, so they are never summed into bucket totals.
  return [...connections.values()]
    .map((connection) => ({
      ...connection,
      buckets: connection.buckets
        .sort((left, right) => left.bucket.localeCompare(right.bucket))
        .map((bucket) => ({
          ...bucket,
          prefixes: bucket.prefixes.sort((left, right) => left.prefix.localeCompare(right.prefix)),
        })),
    }))
    .sort((left, right) =>
      (left.connectionName ?? left.connectionId).localeCompare(
        right.connectionName ?? right.connectionId,
      ),
    );
}
