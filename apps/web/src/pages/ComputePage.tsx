import { Link } from 'react-router-dom';
import { RefreshCw, Settings } from 'lucide-react';
import { executionApi } from '../api/execution';
import { useAuth } from '../hooks/useAuth';
import { useProject } from '../hooks/useProject';
import { useProjectTargets } from '../hooks/useProjectTargets';
import { EXECUTION_POLL_MS, useQuery } from '../hooks/useQuery';
import { PageHeader } from '../components/PageHeader';
import { ComputeTargetsTable } from '../components/ComputeTargetsTable';
import { WorkerPresenceTable } from '../components/WorkerPresenceTable';
import { Resource } from '../components/Feedback';
import { settingsSectionPath } from '../layout/settingsSections';
import { text } from '../i18n/catalog';

/**
 * The computers one may run this Project's Jobs on, read only, and the Project's workers. Adding
 * and managing computers is in 全体設定 → コンピュータ, which this page links to.
 */
export function ComputePage() {
  const { user } = useAuth();
  const { project } = useProject();
  const targets = useProjectTargets(project.id);
  const workers = useQuery(
    `${project.id}:workers`,
    (signal) => executionApi.workers(project.id, signal),
    EXECUTION_POLL_MS,
  );
  return (
    <section className="page management-page">
      <PageHeader
        title={text.compute}
        eyebrow={project.name}
        actions={
          <>
            <Link className="button" to={settingsSectionPath('computers')}>
              <Settings size={15} />
              {text.openComputerSettings}
            </Link>
            <button className="icon-button" aria-label={text.refresh} onClick={targets.reload}>
              <RefreshCw size={17} />
            </button>
          </>
        }
      />
      <p className="muted">{text.projectComputersHint}</p>
      <Resource query={targets}>
        {(items) => <ComputeTargetsTable targets={items} user={user} />}
      </Resource>
      <section className="settings-section">
        <div className="section-heading">
          <h2>{text.workers}</h2>
        </div>
        <Resource query={workers}>
          {(items) => <WorkerPresenceTable workers={items} targets={targets.value ?? []} />}
        </Resource>
      </section>
    </section>
  );
}
