import { useProject } from '../hooks/useProject';
import { useAuditEvents } from '../hooks/useAuditEvents';
import { useProjectMembers } from '../hooks/useProjectMembers';
import { PageHeader } from '../components/PageHeader';
import { ProjectSettings } from '../components/ProjectSettings';
import { ProjectMembers } from '../components/ProjectMembers';
import { ProjectGroupBindings } from '../components/ProjectGroupBindings';
import { ProjectTokens } from '../components/ProjectTokens';
import { ProjectList } from '../components/ProjectList';
import { AuditEventsTable } from '../components/AuditEventsTable';
import { ErrorNotice, Loading } from '../components/Feedback';
import { text } from '../i18n/catalog';

export function SettingsPage() {
  const { project, projects, reloadProjects, isProjectAdmin } = useProject();
  // The API refuses non-administrators, so they never request the log.
  const audit = useAuditEvents(isProjectAdmin ? project.id : null);
  // Shared so a group binding change also refreshes the effective roles in the member list.
  const projectMembers = useProjectMembers(project.id);
  return (
    <section className="page">
      <PageHeader title={text.settings} eyebrow={project.name} />
      <div className="settings-grid">
        <ProjectList projects={projects} onCreated={reloadProjects} />
        <ProjectSettings />
        <ProjectMembers projectMembers={projectMembers} />
        <ProjectGroupBindings onChanged={projectMembers.members.reload} />
        <ProjectTokens />
        {isProjectAdmin && (
          <section className="settings-section">
            <div className="section-heading">
              <h2>{text.auditEvents}</h2>
            </div>
            <ErrorNotice message={audit.error} retry={audit.reload} />
            {audit.loading && !audit.items.length ? (
              <Loading />
            ) : audit.error && !audit.items.length ? null : (
              <AuditEventsTable
                events={audit.items}
                hasMore={audit.hasMore}
                loading={audit.loading}
                onLoadMore={audit.loadMore}
              />
            )}
          </section>
        )}
      </div>
    </section>
  );
}
