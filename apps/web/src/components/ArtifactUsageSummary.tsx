import { useArtifactUsage } from '../hooks/useArtifactUsage';
import { formatBytes } from '../lib/format';
import { Resource } from './Feedback';
import { ResponsiveTable } from './ResponsiveTable';
import { text, textTemplates } from '../i18n/catalog';

/** Stored Artifacts of the Project per backend, with what deletion and old versions hold. */
export function ArtifactUsageSummary({ projectId }: { projectId: string }) {
  const usage = useArtifactUsage(projectId);
  return (
    <section className="settings-section artifact-usage">
      <h2>{text.artifactUsage}</h2>
      <Resource query={usage}>
        {({ backends, deleteGraceDays }) => (
          <>
            {backends.length ? (
              <ResponsiveTable
                rows={backends}
                rowKey={(backend) => backend.backend}
                columns={[
                  {
                    key: 'backend',
                    priority: 'primary',
                    header: text.artifactUsageBackend,
                    className: 'mono',
                    render: (backend) => backend.backend,
                  },
                  {
                    key: 'count',
                    priority: 'secondary',
                    header: text.artifactUsageCount,
                    render: (backend) => backend.artifactCount,
                  },
                  {
                    key: 'bytes',
                    priority: 'primary',
                    header: text.artifactUsageBytes,
                    render: (backend) => formatBytes(backend.totalBytes),
                  },
                  {
                    key: 'pendingDeletion',
                    priority: 'secondary',
                    header: text.artifactUsagePendingDeletion,
                    render: (backend) =>
                      textTemplates.artifactUsageFiles(
                        backend.pendingDeletionCount,
                        formatBytes(backend.pendingDeletionBytes),
                      ),
                  },
                  {
                    key: 'oldVersions',
                    priority: 'secondary',
                    header: text.artifactUsageOldVersions,
                    render: (backend) =>
                      textTemplates.artifactUsageFiles(
                        backend.unreferencedOldVersionCount,
                        formatBytes(backend.unreferencedOldVersionBytes),
                      ),
                  },
                ]}
              />
            ) : (
              <p className="muted">{text.artifactUsageEmpty}</p>
            )}
            <p className="muted">{textTemplates.artifactUsageNote(deleteGraceDays)}</p>
          </>
        )}
      </Resource>
    </section>
  );
}
