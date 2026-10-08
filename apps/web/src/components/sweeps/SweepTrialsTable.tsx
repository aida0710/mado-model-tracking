import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { SweepObjective, SweepTrial, SweepTrialState } from '@mmt/contracts';
import { formatNumber, formatValue } from '../../lib/format';
import { sortTrials, trialParameterNames, type SweepTrialOrder } from '../../lib/sweepTrials';
import { ResponsiveTable, type ResponsiveTableColumn } from '../ResponsiveTable';
import { sweepTrialStateLabels } from '../../i18n/sweeps';
import { text, textTemplates } from '../../i18n/catalog';

// early_stopped gets its own color so it is not read as a user cancel.
const TRIAL_BADGE_CLASSES: Record<SweepTrialState, string> = {
  queued: 'status-queued',
  running: 'status-running',
  finished: 'status-finished',
  failed: 'status-failed',
  canceled: 'status-canceled',
  early_stopped: 'status-early-stopped',
};

// Sampled values carry every float digit; six significant digits keep the columns readable.
const formatParameter = (value: unknown) => (typeof value === 'number' ? formatNumber(value) : formatValue(value));

function SweepTrialStateBadge({ trial }: { trial: SweepTrial }) {
  return (
    <span className={`status-badge ${TRIAL_BADGE_CLASSES[trial.state]}`}
      title={trial.stopReason ? textTemplates.sweepEarlyStoppedReason(trial.stopReason) : undefined}>
      <span aria-hidden="true">●</span>
      {sweepTrialStateLabels[trial.state]}
    </span>
  );
}

interface SweepTrialTableInput {
  projectId: string;
  trials: SweepTrial[];
  objective: SweepObjective;
  bestTrialId: string | null;
}

/**
 * The trial table's columns. On narrow screens a row keeps the trial index, objective and state;
 * parameters and the Run/Job links open beneath it.
 */
export function sweepTrialColumns({
  projectId,
  trials,
  objective,
  bestTrialId,
}: SweepTrialTableInput): ResponsiveTableColumn<SweepTrial>[] {
  const parameterColumns: ResponsiveTableColumn<SweepTrial>[] = trialParameterNames(trials).map((name) => ({
    key: `parameter:${name}`,
    header: <span className="mono">{name}</span>,
    className: 'mono',
    priority: 'secondary',
    render: (trial) => formatParameter(trial.parameters[name]),
  }));
  return [
    {
      key: 'trial',
      header: text.sweepTrialIndex,
      className: 'mono',
      priority: 'primary',
      render: (trial) => textTemplates.sweepTrialRunName(trial.trialIndex),
    },
    ...parameterColumns,
    {
      key: 'objective',
      header: `${text.sweepObjectiveValue}（${objective.metric}）`,
      className: 'mono',
      priority: 'primary',
      render: (trial) => (
        <>
          {trial.objectiveValue === null ? '—' : formatNumber(trial.objectiveValue)}
          {trial.id === bestTrialId && <small className="sweep-best-marker">{text.sweepBestTrial}</small>}
        </>
      ),
    },
    {
      key: 'state',
      header: text.sweepTrialState,
      priority: 'primary',
      render: (trial) => <SweepTrialStateBadge trial={trial} />,
    },
    {
      key: 'run',
      header: text.sweepTrialRun,
      priority: 'secondary',
      render: (trial) => <Link to={`/projects/${projectId}/runs/${trial.runId}`}>{text.automationRun}</Link>,
    },
    {
      key: 'job',
      header: text.sweepTrialJob,
      priority: 'secondary',
      render: (trial) => (
        <>
          <Link to={`/projects/${projectId}/jobs?job=${trial.jobId}`}>{text.automationJob}</Link>
          {trial.jobCancelRequested && <small> {text.cancelRequested}</small>}
        </>
      ),
    },
  ];
}

/** One row per trial: its parameters, objective, state and the Run/Job it ran as. */
export function SweepTrialsTable({
  projectId,
  trials,
  objective,
  bestTrialId,
}: SweepTrialTableInput) {
  const [order, setOrder] = useState<SweepTrialOrder>('trial_index');
  return (
    <div className="sweep-trials" data-testid="sweep-trials">
      <label className="chart-selector">
        <span>{text.sort}</span>
        <select aria-label={text.sort} value={order} onChange={(event) => setOrder(event.target.value as SweepTrialOrder)}>
          <option value="trial_index">{text.sweepSortByTrial}</option>
          <option value="objective">{text.sweepSortByObjective}</option>
        </select>
      </label>
      <ResponsiveTable
        rows={sortTrials(trials, order, objective.goal)}
        rowKey={(trial) => trial.id}
        empty={text.sweepNoTrials}
        columns={sweepTrialColumns({ projectId, trials, objective, bestTrialId })}
      />
    </div>
  );
}
