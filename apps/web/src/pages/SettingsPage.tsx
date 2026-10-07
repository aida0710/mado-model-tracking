import { useProject } from '../hooks/useProject';
import { PageHeader } from '../components/PageHeader';
import { ProjectSettings } from '../components/ProjectSettings';
import { ProjectMembers } from '../components/ProjectMembers';
import { ProjectTokens } from '../components/ProjectTokens';
import { text } from '../i18n/catalog';

export function SettingsPage() {
  const { project } = useProject();
  return (
    <section className="page">
      <PageHeader title={text.settings} eyebrow={project.name} />
      <div className="settings-grid">
        <ProjectSettings />
        <ProjectMembers />
        <ProjectTokens />
      </div>
    </section>
  );
}
