import { Link, useParams } from 'react-router-dom';
import { RefreshCw } from 'lucide-react';
import type { MetricSeries, SweepTrial } from '@mmt/contracts';
import { useAuth } from '../hooks/useAuth';
import { useProject } from '../hooks/useProject';
import { useSweepDetail, useTrialObjectiveSeries, type SweepDetail } from '../hooks/useSweeps';
import { canControlSweep } from '../lib/permissions';
import { formatDate } from '../lib/format';
import { PageHeader } from '../components/PageHeader';
import { Empty, Resource } from '../components/Feedback';
import { DetailsList, JsonDetails } from '../components/JsonDetails';
import { SweepSummary } from '../components/sweeps/SweepSummary';
import { SweepProgressChart } from '../components/sweeps/SweepProgressChart';
import { SweepTrialsTable } from '../components/sweeps/SweepTrialsTable';
import { MetricsChart } from '../components/charts/MetricsChart';
import type { MetricsChartProps } from '../components/charts/chartProps';
import { RunAnalysisPanel } from '../components/analysis/RunAnalysisPanel';
import { sweepAggregationLabels, sweepGoalLabels, sweepMethodLabels } from '../i18n/sweeps';
import { text, textTemplates } from '../i18n/catalog';

export function SweepDetailPage() {
  const { sweepId = '' } = useParams();
  const { project } = useProject();
  const auth = useAuth();
  const detail = useSweepDetail(project.id, sweepId);
  return (
    <section className="page sweep-detail-page" data-testid="sweep-detail-page">
      <Resource query={detail}>
        {({ sweep, trials }) => (
          <>
            <PageHeader
              title={sweep.name}
              eyebrow={<Link to={`/projects/${project.id}/sweeps`}>{text.sweeps}</Link>}
              actions={<button className="icon-button" aria-label={text.refresh} onClick={detail.reload}><RefreshCw size={17} /></button>}
            />
            <SweepSummary projectId={project.id} sweep={sweep}
              canControl={canControlSweep(project.role, auth.user.id, sweep)} onChanged={detail.reload} />
            <div className="sweep-detail-grid">
              <section>
                <h2>{text.sweepProgressChart}</h2>
                <SweepProgressChart trials={trials} objective={sweep.objective} />
              </section>
              <section>
                <h2>{text.sweepDefinition}</h2>
                <DetailsList entries={[
                  [text.sweepMethod, sweepMethodLabels[sweep.method]],
                  [text.sweepObjective, `${sweep.objective.metric}・${sweepGoalLabels[sweep.objective.goal]}・${sweepAggregationLabels[sweep.objective.aggregation]}`],
                  [text.sweepParallelism, sweep.parallelism],
                  [text.sweepEarlyStopping, sweep.earlyStopping
                    ? `hyperband（min_iter ${sweep.earlyStopping.minIter}, eta ${sweep.earlyStopping.eta}${sweep.earlyStopping.maxIter ? `, max_iter ${sweep.earlyStopping.maxIter}` : ''}）`
                    : text.sweepEarlyStoppingNone],
                  [text.sweepTaskRevision, <Link to={`/projects/${project.id}/tasks?id=${sweep.taskId}`}>{sweep.taskRevision}</Link>],
                  [text.sweepSeedValue, <span className="mono">{sweep.seed}</span>],
                  [text.created, formatDate(sweep.createdAt)],
                ]} />
                <details>
                  <summary>{text.sweepSearchSpace}</summary>
                  <JsonDetails value={sweep.searchSpace} />
                </details>
              </section>
            </div>
            <h2>{text.sweepTrialList}</h2>
            <SweepTrialsTable projectId={project.id} trials={trials} objective={sweep.objective}
              bestTrialId={sweep.bestTrial?.id ?? null} />
            <h2>{text.sweepObjectiveHistory}</h2>
            <TrialObjectiveHistory projectId={project.id} detail={{ sweep, trials }} />
            <h2>{text.sweepAnalysis}</h2>
            <RunAnalysisPanel projectId={project.id} runSet={{ sweepId: sweep.id }} />
          </>
        )}
      </Resource>
    </section>
  );
}

/** The objective metric of each trial Run by step, overlaid in one chart. */
function TrialObjectiveHistory({ projectId, detail }: { projectId: string; detail: SweepDetail }) {
  const { series, shownTrials, totalTrials } = useTrialObjectiveSeries(projectId, detail);
  return (
    <>
      {shownTrials.length < totalTrials && <p className="muted">{textTemplates.sweepSeriesLimited(shownTrials.length, totalTrials)}</p>}
      <Resource query={series}>
        {(items) => {
          const chartSeries = toChartSeries(items, shownTrials);
          if (!chartSeries.length) return <Empty>{text.noMetrics}</Empty>;
          return (
            <MetricsChart
              series={chartSeries}
              xAxis={{ kind: 'step' }}
              yScale="linear"
              smoothing={{ kind: 'none', weight: 0 }}
              showRange={false}
              showRaw={false}
            />
          );
        }}
      </Resource>
    </>
  );
}

function toChartSeries(series: MetricSeries[], trials: SweepTrial[]): MetricsChartProps['series'] {
  const trialByRunId = new Map(trials.map((trial) => [trial.runId, trial]));
  return series
    .filter((item) => item.points.length > 0)
    .map((item) => ({
      id: item.runId,
      label: textTemplates.sweepTrialRunName(trialByRunId.get(item.runId)?.trialIndex ?? 0),
      kind: 'run' as const,
      points: item.points.map((point) => ({ x: point.x, value: point.value, min: point.min, max: point.max })),
    }));
}
