import { Link } from 'react-router-dom';
import type { Run } from '@mmt/contracts';
import { useRunOutputRegistration } from '../hooks/useRunOutputRegistration';
import type { RunOutputRegistrationState } from '../lib/runOutputRegistrationState';
import { text } from '../i18n/catalog';

function VersionLink({ projectId, id }: { projectId: string; id: string }) {
  return <Link className="version-link mono" to={`/projects/${projectId}/models?version=${id}`}>{id}</Link>;
}

export function RunOutputRegistrationStatus({ projectId, state }: {
  projectId: string; state: RunOutputRegistrationState;
}) {
  switch (state.kind) {
    case 'none': return null;
    case 'pending': return <p className="muted" data-testid="output-registration-pending">{text.outputRegistrationPending}</p>;
    case 'failed': return <div className="notice error" role="alert" data-testid="output-registration-failed">
      {text.outputRegistrationFailed}{state.error && `: ${state.error}`}
    </div>;
    default: return <p data-testid={`output-registration-${state.kind}`}>
      {state.kind === 'skipped' ? text.outputRegistrationSkipped : text.outputRegistrationRegistered}:{' '}
      <VersionLink projectId={projectId} id={state.modelVersionId} />
    </p>;
  }
}

// Run.outputModelVersionIds is derived by the API in registration order.
export function RunOutputModels({ run }: { run: Run }) {
  const registration = useRunOutputRegistration(run);
  const { state } = registration;
  // The registration line already links its version, so the plain list leaves it out.
  const otherVersionIds = run.outputModelVersionIds.filter((id) => !('modelVersionId' in state) || id !== state.modelVersionId);
  if (!run.outputModelVersionIds.length && state.kind === 'none' && !registration.error) return '—';
  return <>
    {otherVersionIds.map((id) => <VersionLink key={id} projectId={run.projectId} id={id} />)}
    <RunOutputRegistrationStatus projectId={run.projectId} state={state} />
    {registration.error && <div className="notice error" role="alert">{text.outputRegistrationLoadError}</div>}
  </>;
}
