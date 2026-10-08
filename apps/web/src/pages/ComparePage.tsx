import { Link, useSearchParams } from 'react-router-dom';
import { useProject } from '../hooks/useProject';
import { EXECUTION_POLL_MS, useQuery } from '../hooks/useQuery';
import { trackingApi } from '../api/tracking';
import { Resource } from '../components/Feedback';
import { PageHeader } from '../components/PageHeader';
import { MetricsChart } from '../components/MetricsChart';
import { ArtifactCompare } from '../components/ArtifactCompare';
import { Tabs } from '../components/Tabs';
import { StatusBadge } from '../components/StatusBadge';
import { formatValue } from '../lib/format';
import { getRunParameters } from '../lib/runParameters';
import { text } from '../i18n/catalog';

export function ComparePage() {
  const { project } = useProject();
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'artifacts' ? 'artifacts' : 'details';
  const ids = Array.from(new Set((params.get('runs') ?? '').split(',').filter(Boolean)));
  const comparison = useQuery(
    `${project.id}:compare:${ids.join(',')}`,
    (signal) =>
      Promise.all(
        ids.map(async (id) => {
          const run = await trackingApi.run(project.id, id, signal);
          return {
            run: { ...run, parameters: getRunParameters(run) },
            points: await trackingApi.metrics(project.id, id, signal),
          };
        }),
      ),
    EXECUTION_POLL_MS,
  );
  return (
    <section className="page">
      <PageHeader
        title={text.compare}
        eyebrow={<Link to={`/projects/${project.id}/experiments`}>{text.experiments}</Link>}
      />
      <Tabs
        tabs={[
          { key: 'details', label: text.details },
          { key: 'artifacts', label: text.artifacts },
        ]}
        selected={tab}
        onSelect={(key) =>
          setParams(
            (previous) => {
              const next = new URLSearchParams(previous);
              if (key === 'artifacts') next.set('tab', key);
              else next.delete('tab');
              return next;
            },
            { replace: true },
          )
        }
        panelId="compare-tab-panel"
      />
      <div id="compare-tab-panel" role="tabpanel">
        <Resource query={comparison}>
          {(items) => tab === 'artifacts' ? (
            <ArtifactCompare projectId={project.id} runs={items.map((item) => item.run)} />
          ) : (
            <>
              <MetricsChart
                series={items.map((item) => ({
                  id: item.run.id,
                  label: item.run.name,
                  points: item.points,
                }))}
              />
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>{text.details}</th>
                      {items.map(({ run }) => (
                        <th key={run.id}>
                          <Link to={`/projects/${project.id}/runs/${run.id}`}>{run.name}</Link>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <th>{text.status}</th>
                      {items.map(({ run }) => (
                        <td key={run.id}>
                          <StatusBadge status={run.status} />
                        </td>
                      ))}
                    </tr>
                    {(['parameters', 'latestMetrics', 'tags'] as const).flatMap((namespace) =>
                      Array.from(new Set(items.flatMap((item) => Object.keys(item.run[namespace]))))
                        .sort()
                        .map((key) => (
                          <tr key={`${namespace}.${key}`}>
                            <th>
                              <small>
                                {namespace === 'latestMetrics' ? text.metrics : text[namespace]}
                              </small>
                              {key}
                            </th>
                            {items.map(({ run }) => (
                              <td key={run.id} className="mono">
                                {formatValue(run[namespace][key])}
                              </td>
                            ))}
                          </tr>
                        )),
                    )}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </Resource>
      </div>
    </section>
  );
}
