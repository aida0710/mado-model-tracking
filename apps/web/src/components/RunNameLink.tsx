import { Link } from 'react-router-dom';
import { trackingApi } from '../api/tracking';
import { useQuery } from '../hooks/useQuery';

/** A link to a Run by its name, loaded on its own; the id stays until the name arrives or if it fails. */
export function RunNameLink({ projectId, runId }: { projectId: string; runId: string }) {
  const run = useQuery(`${projectId}:run:${runId}`, (signal) =>
    trackingApi.run(projectId, runId, signal),
  );
  return (
    <Link to={`/projects/${projectId}/runs/${runId}`} title={runId}>
      {run.value?.name ?? runId}
    </Link>
  );
}
