import { describe, expect, it } from 'vitest';
import { parsePrometheus } from './prometheus';
import { buildStorageMetrics } from './storageMetrics';

describe('buildStorageMetrics', () => {
  it('同じbucket名でもconnectionごとに分け、後から返るconnection名を対応づける', () => {
    const connections = buildStorageMetrics(
      parsePrometheus(`
mado_storage_bucket_bytes{connection_id="c1",bucket="audio"} 4096
mado_storage_bucket_bytes{connection_id="c2",bucket="audio"} 8192
mado_storage_prefix_bytes{connection_id="c1",bucket="audio",prefix="speech/"} 1024
mado_storage_bucket_objects{connection_id="c1",bucket="audio"} 3
mado_storage_prefix_objects{connection_id="c1",bucket="audio",prefix="speech/"} 1
mado_storage_connection_info{connection_id="c1",connection_name="First"} 1
mado_storage_capacity_tracking_enabled{connection_id="c1"} 1
mado_storage_capacity_tracking_interval_seconds{connection_id="c1"} 300
`).samples,
    );
    const first = connections.find((connection) => connection.connectionId === 'c1');
    const second = connections.find((connection) => connection.connectionId === 'c2');
    expect(first?.connectionName).toBe('First');
    expect(first?.trackingEnabled?.value).toBe(1);
    expect(first?.intervalSeconds?.value).toBe(300);
    expect(first?.buckets[0]?.bytes?.value).toBe(4096);
    expect(second?.buckets[0]?.bytes?.value).toBe(8192);
    expect(first?.buckets[0]?.prefixes[0]?.objects?.value).toBe(1);
    // A partial prefix listing must not replace or be added to a bucket's measured total.
    expect(first?.buckets[0]?.prefixes[0]?.bytes?.value).toBe(1024);
  });

  it('失敗回数だけの未計測bucketを容量・件数・経過時間ゼロとして扱わない', () => {
    const connections = buildStorageMetrics(
      parsePrometheus(`
mado_storage_capacity_collection_failures{connection_id="c1",bucket="unmeasured"} 2
mado_storage_capacity_collection_failures{connection_id="c1",bucket="empty"} 0
mado_storage_bucket_bytes{connection_id="c1",bucket="empty"} 0
mado_storage_bucket_objects{connection_id="c1",bucket="empty"} 0
mado_storage_capacity_collection_age_seconds{connection_id="c1",bucket="empty"} 12.5
`).samples,
    );
    const unmeasured = connections[0]?.buckets.find((bucket) => bucket.bucket === 'unmeasured');
    const empty = connections[0]?.buckets.find((bucket) => bucket.bucket === 'empty');
    expect(unmeasured?.failures?.value).toBe(2);
    expect(unmeasured?.bytes).toBeUndefined();
    expect(unmeasured?.objects).toBeUndefined();
    expect(unmeasured?.ageSeconds).toBeUndefined();
    expect(empty?.bytes?.value).toBe(0);
    expect(empty?.objects?.value).toBe(0);
    expect(empty?.ageSeconds?.value).toBe(12.5);
  });

  it('空のmetricsと無関係なmetricから容量データを作らない', () => {
    expect(buildStorageMetrics([])).toEqual([]);
    expect(
      buildStorageMetrics(parsePrometheus('http_requests_total{connection_id="c1"} 100').samples),
    ).toEqual([]);
  });
});
