import { useState } from 'react';
import type { Artifact } from '@mmt/contracts';
import { Download } from 'lucide-react';
import { DataTable } from './DataTable';
import { ArtifactPreview } from './ArtifactPreview';
import { trackingApi } from '../api/tracking';
import { formatBytes } from '../lib/format';
import { text } from '../i18n/catalog';

export function RunArtifacts({ artifacts }: { artifacts: Artifact[] }) {
  const [selectedId, setSelectedId] = useState('');
  const selected = artifacts.find((item) => item.id === selectedId) ?? artifacts[0];
  return (
    <div className="artifact-layout">
      <DataTable
        items={artifacts}
        rowKey={(item) => item.id}
        selectedKey={selected?.id}
        empty={text.noArtifacts}
        columns={[
          {
            key: 'path',
            label: text.artifactPath,
            render: (item) => (
              <button className="link-button" onClick={() => setSelectedId(item.id)}>
                {item.path}
              </button>
            ),
          },
          {
            key: 'size',
            label: text.size,
            className: 'mono',
            render: (item) => formatBytes(item.size),
          },
          {
            key: 'download',
            label: text.download,
            render: (item) => (
              <a
                href={trackingApi.artifactUrl(item.projectId, item.id)}
                download={item.path.split('/').pop()}
                aria-label={`${text.download}: ${item.path}`}
              >
                <Download size={16} />
              </a>
            ),
          },
        ]}
      />
      {selected && (
        <section className="artifact-preview">
          <h3>{selected.path}</h3>
          <p className="mono muted">
            {selected.mimeType} · {formatBytes(selected.size)}
          </p>
          <ArtifactPreview key={selected.id} artifact={selected} />
          <details>
            <summary>{text.details}</summary>
            <p className="mono break-word">
              {text.artifactId}: {selected.id}
            </p>
            <p className="mono break-word">SHA-256 {selected.sha256}</p>
            <p className="mono">{selected.backend}</p>
          </details>
        </section>
      )}
    </div>
  );
}
