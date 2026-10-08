import { Link } from 'react-router-dom';
import type { ModelVersion } from '@mmt/contracts';
import { trackingApi } from '../api/tracking';
import { useQuery } from '../hooks/useQuery';
import { text } from '../i18n/catalog';

/**
 * The version's weights Artifact by its saved path, with a download link and a link to the
 * Artifacts page narrowed to the version. The id is shown while the Artifact loads.
 */
export function ModelVersionArtifactLink({
  projectId,
  version,
}: {
  projectId: string;
  version: Pick<ModelVersion, 'id' | 'modelId' | 'artifactId'>;
}) {
  const artifactId = version.artifactId;
  const artifact = useQuery(artifactId ? `${projectId}:artifact:${artifactId}` : null, (signal) =>
    trackingApi.artifact(projectId, artifactId!, signal),
  );
  if (!artifactId) return <>—</>;
  const catalogUrl = `/projects/${projectId}/artifacts?modelId=${encodeURIComponent(
    version.modelId,
  )}&modelVersionId=${encodeURIComponent(version.id)}`;
  return (
    <span className="model-version-artifact">
      <a
        className="mono break-word"
        href={trackingApi.artifactUrl(projectId, artifactId)}
        title={artifactId}
        download={artifact.value?.path.split('/').pop()}
      >
        {artifact.value?.path ?? artifactId}
      </a>{' '}
      <Link className="button small" to={catalogUrl}>
        {text.modelVersionArtifactOpen}
      </Link>
    </span>
  );
}
