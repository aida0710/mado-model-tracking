import { useState } from 'react';
import { useProject } from '../hooks/useProject';
import { useAuditEvents } from '../hooks/useAuditEvents';
import { useProjectMembers } from '../hooks/useProjectMembers';
import { useServiceAccounts } from '../hooks/useServiceAccounts';
import { PageHeader } from '../components/PageHeader';
import { ProjectSettings } from '../components/ProjectSettings';
import { ArtifactUsageSummary } from '../components/ArtifactUsageSummary';
import { MlflowConnectionCard } from '../components/MlflowConnectionCard';
import { ProjectMembers } from '../components/ProjectMembers';
import { ProjectGroupBindings } from '../components/ProjectGroupBindings';
import { ProjectTokens } from '../components/ProjectTokens';
import { ProjectServiceAccounts } from '../components/ProjectServiceAccounts';
import { NotificationSettings } from '../components/NotificationSettings';
import { ProjectArchiveSection } from '../components/ProjectArchiveSection';
import { AuditEventLog } from '../components/AuditEventLog';
import { text } from '../i18n/catalog';

/**
 * The open Project's own settings. Creating and listing Projects belong to the Project switcher
 * and 全体管理.
 */
export function SettingsPage() {
  const { project, isProjectAdmin } = useProject();
  // The API refuses non-administrators, so they never request the log.
  const audit = useAuditEvents(isProjectAdmin ? { projectId: project.id } : null);
  // Shared so a group binding change also refreshes the effective roles in the member list.
  const projectMembers = useProjectMembers(project.id);
  // Shared so a key issued to a Service Account appears in the Project token list.
  const serviceAccounts = useServiceAccounts(project.id, isProjectAdmin);
  // ProjectTokens loads the personal tokens itself; remounting it shows a token issued from the
  // MLflow connection card.
  const [tokenListRevision, setTokenListRevision] = useState(0);
  const reloadTokenLists = () => {
    setTokenListRevision((revision) => revision + 1);
    if (isProjectAdmin) serviceAccounts.projectTokens.reload();
  };
  return (
    <section className="page management-page">
      <PageHeader title={text.settings} eyebrow={project.name} />
      <div className="settings-grid">
        <ProjectSettings />
        <ArtifactUsageSummary projectId={project.id} />
      </div>
      <div className="settings-stack">
        <MlflowConnectionCard onTokenCreated={reloadTokenLists} />
        <ProjectMembers projectMembers={projectMembers} />
        <ProjectGroupBindings onChanged={projectMembers.members.reload} />
        <ProjectServiceAccounts access={serviceAccounts} />
        <ProjectTokens key={tokenListRevision} projectTokens={serviceAccounts.projectTokens} />
        <NotificationSettings />
        {isProjectAdmin && (
          <section className="settings-section">
            <div className="section-heading">
              <h2>{text.auditEvents}</h2>
            </div>
            <AuditEventLog audit={audit} />
          </section>
        )}
        {isProjectAdmin && <ProjectArchiveSection />}
      </div>
    </section>
  );
}
