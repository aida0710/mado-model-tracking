import { RefreshCw } from 'lucide-react';
import { trackingApi } from '../api/tracking';
import { useProject } from '../hooks/useProject';
import { useQuery } from '../hooks/useQuery';
import { PageHeader } from '../components/PageHeader';
import { Resource } from '../components/Feedback';
import { LineageGraph } from '../components/LineageGraph';
import { text } from '../i18n/catalog';

export function LineagePage() {
  const { project } = useProject();
  const graph = useQuery(`${project.id}:lineage`, (signal) =>
    trackingApi.lineage(project.id, signal),
  );
  return (
    <section className="page">
      <PageHeader
        title={text.lineage}
        eyebrow={project.name}
        actions={
          <button className="icon-button" aria-label={text.refresh} onClick={graph.reload}>
            <RefreshCw size={17} />
          </button>
        }
      />
      <Resource query={graph}>
        {(value) => <LineageGraph graph={value} projectId={project.id} />}
      </Resource>
    </section>
  );
}
