import { useProject } from '../hooks/useProject';
import { useAuditEvents } from '../hooks/useAuditEvents';
import { PageHeader } from '../components/PageHeader';
import { ProjectSettings } from '../components/ProjectSettings';
import { ProjectMembers } from '../components/ProjectMembers';
import { ProjectTokens } from '../components/ProjectTokens';
import { AuditEventsTable, auditText } from '../components/AuditEventsTable';
import { ErrorNotice, Loading } from '../components/Feedback';
import { text } from '../i18n/catalog';

export function SettingsPage() {
  const { project, isProjectAdmin } = useProject();
  // The API refuses non-administrators, so they never request the log.
  const audit = useAuditEvents(isProjectAdmin ? project.id : null);
  return (
    <section className="page">
      <PageHeader title={text.settings} eyebrow={project.name} />
      <div className="settings-grid">
        <ProjectSettings />
        <ProjectMembers />
        <ProjectTokens />
        {isProjectAdmin && (
          <section className="settings-section">
            <div className="section-heading">
              <h2>{auditText('auditEvents')}</h2>
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
