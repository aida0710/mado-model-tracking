import type { Artifact } from '@mmt/contracts';
import { runMediaApi } from '../../api/runMedia';
import { useQuery } from '../../hooks/useQuery';
import { Resource } from '../Feedback';
import { MediaTableView } from '../media/MediaTableView';
import { TextPreview } from './TextPreview';

/**
 * A Run's JSON file drawn as the media table it was logged as (MLflow log_table or a native table),
 * with the same audio and image cells as the Media tab. Other JSON files stay plain text.
 */
export function MediaTablePreview({ artifact, runId }: { artifact: Artifact; runId: string }) {
  const table = useQuery(`${artifact.projectId}:artifact-media-table:${artifact.id}`, (signal) =>
    runMediaApi.tableOfArtifact(artifact.projectId, { runId, artifactId: artifact.id }, signal),
  );
  return (
    <Resource query={table}>
      {(media) =>
        media ? (
          <MediaTableView projectId={artifact.projectId} runId={runId} mediaId={media.id} />
        ) : (
          <TextPreview artifact={artifact} />
        )
      }
    </Resource>
  );
}
