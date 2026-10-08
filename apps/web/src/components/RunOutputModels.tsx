import { Link } from 'react-router-dom';

// Run.outputModelVersionIds is derived by the API in registration order.
export function RunOutputModels({
  projectId,
  versionIds,
}: {
  projectId: string;
  versionIds: string[];
}) {
  return versionIds.map((id) => (
    <Link className="version-link mono" key={id} to={`/projects/${projectId}/models?version=${id}`}>
      {id}
    </Link>
  ));
}
