import type { StorageBackend } from '@mmt/contracts';
import { Lock } from 'lucide-react';
import { DataTable } from '../DataTable';
import { text } from '../../i18n/catalog';

/** Lists the storage backends with the actions a global administrator may take on each. */
export function StorageBackendsTable({
  backends,
  defaultBackend,
  testingBackend,
  onTest,
  onEdit,
  onMakeDefault,
}: {
  backends: StorageBackend[];
  defaultBackend: string;
  /** The backend whose connection test is running; its button shows the wait. */
  testingBackend: string | null;
  onTest: (backend: StorageBackend) => void;
  onEdit: (backend: StorageBackend) => void;
  onMakeDefault: (backend: StorageBackend) => void;
}) {
  return (
    <DataTable
      items={backends}
      rowKey={(backend) => backend.name}
      empty={text.storageNoBackends}
      columns={[
        {
          key: 'name',
          label: text.name,
          render: (backend) => (
            <span className="storage-name">
              <strong>{backend.name}</strong>
              {backend.name === defaultBackend && (
                <span className="storage-tag storage-default">{text.storageDefaultMark}</span>
              )}
            </span>
          ),
        },
        { key: 'kind', label: text.storageBackendKind, render: (backend) => text[backend.kind] },
        {
          key: 'location',
          label: text.storageLocation,
          className: 'storage-location',
          render: (backend) => <code>{describeLocation(backend)}</code>,
        },
        {
          key: 'signature',
          label: text.storageSignature,
          render: (backend) => (backend.kind === 's3' ? backend.signatureVersion : ''),
        },
        {
          key: 'state',
          label: text.storageState,
          render: (backend) => (backend.enabled ? text.enabled : text.disabled),
        },
        {
          key: 'source',
          label: text.storageSource,
          render: (backend) =>
            backend.source === 'environment' ? (
              <span className="storage-readonly" title={text.storageEnvironmentReadOnly}>
                <Lock size={12} aria-hidden="true" />
                {text.storageSourceEnvironment}
              </span>
            ) : (
              text.storageSourceDatabase
            ),
        },
        {
          key: 'actions',
          label: <span className="sr-only">{text.edit}</span>,
          className: 'storage-actions',
          render: (backend) => (
            <span className="storage-row-actions">
              <button
                className="button small"
                disabled={testingBackend !== null}
                onClick={() => onTest(backend)}
              >
                {testingBackend === backend.name ? text.loading : text.storageTest}
              </button>
              {backend.source === 'database' && (
                <button className="button small" onClick={() => onEdit(backend)}>
                  {text.edit}
                </button>
              )}
              {backend.enabled && backend.name !== defaultBackend && (
                <button className="button small" onClick={() => onMakeDefault(backend)}>
                  {text.storageMakeDefault}
                </button>
              )}
            </span>
          ),
        },
      ]}
    />
  );
}

function describeLocation(backend: StorageBackend): string {
  if (backend.kind === 'filesystem') return backend.rootPath ?? '';
  const bucketPath = [backend.bucket, backend.prefix].filter(Boolean).join('/');
  return backend.endpoint ? `${backend.endpoint} ${bucketPath}` : bucketPath;
}
