import { useArtifactUsage } from '../hooks/useArtifactUsage';
import { formatBytes } from '../lib/format';
import { Resource } from './Feedback';
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
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>{text.artifactUsageBackend}</th>
                      <th>{text.artifactUsageCount}</th>
                      <th>{text.artifactUsageBytes}</th>
                      <th>{text.artifactUsagePendingDeletion}</th>
                      <th>{text.artifactUsageOldVersions}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {backends.map((backend) => (
                      <tr key={backend.backend}>
                        <td className="mono">{backend.backend}</td>
                        <td>{backend.artifactCount}</td>
                        <td>{formatBytes(backend.totalBytes)}</td>
                        <td>
                          {textTemplates.artifactUsageFiles(
                            backend.pendingDeletionCount,
                            formatBytes(backend.pendingDeletionBytes),
                          )}
                        </td>
                        <td>
                          {textTemplates.artifactUsageFiles(
                            backend.unreferencedOldVersionCount,
                            formatBytes(backend.unreferencedOldVersionBytes),
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
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
