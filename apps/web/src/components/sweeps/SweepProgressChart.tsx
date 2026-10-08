import {
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Scatter,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { SweepObjective, SweepTrial } from '@mmt/contracts';
import { formatNumber } from '../../lib/format';
import { objectiveProgress } from '../../lib/sweepTrials';
import { Empty } from '../Feedback';
import { text } from '../../i18n/catalog';

const OBJECTIVE_COLOR = '#647ee5';
const BEST_COLOR = '#008c88';
const CHART_HEIGHT = 280;

/** Objective per trial as dots, with the best so far as a step line (x is the trial index). */
export function SweepProgressChart({ trials, objective }: { trials: SweepTrial[]; objective: SweepObjective }) {
  const points = objectiveProgress(trials, objective.goal);
  if (!points.length) return <Empty>{text.sweepNoBestTrial}</Empty>;
  return (
    <div className="sweep-progress-chart" role="img" aria-label={`${text.sweepProgressChart}: ${objective.metric}`}
      style={{ height: CHART_HEIGHT }}>
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={points} margin={{ top: 12, right: 24, left: 12, bottom: 8 }} accessibilityLayer>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
          <XAxis dataKey="trialIndex" type="number" domain={['dataMin', 'dataMax']} allowDecimals={false}
            tick={{ fontSize: 11 }} label={{ value: text.sweepTrialIndex, position: 'insideBottomRight', offset: -4, fontSize: 11 }} />
          <YAxis tickFormatter={formatNumber} width={70} domain={['auto', 'auto']} tick={{ fontSize: 11 }} />
          <Tooltip formatter={(value) => (typeof value === 'number' ? formatNumber(value) : String(value))}
            contentStyle={{ background: 'var(--surface)', border: '1px solid var(--border)' }} />
          <Legend />
          <Scatter dataKey="objective" name={text.sweepTrialObjective} fill={OBJECTIVE_COLOR} isAnimationActive={false} />
          <Line dataKey="bestSoFar" name={text.sweepBestSoFar} type="stepAfter" stroke={BEST_COLOR} dot={false}
            strokeWidth={2} isAnimationActive={false} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
