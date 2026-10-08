import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { SweepObjective, SweepTrial, SweepTrialState } from '@mmt/contracts';
import { formatNumber, formatValue } from '../../lib/format';
import { sortTrials, trialParameterNames, type SweepTrialOrder } from '../../lib/sweepTrials';
import { DataTable, type TableColumn } from '../DataTable';
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

/** One row per trial: its parameters, objective, state and the Run/Job it ran as. */
export function SweepTrialsTable({
  projectId,
  trials,
  objective,
  bestTrialId,
}: {
  projectId: string;
  trials: SweepTrial[];
  objective: SweepObjective;
  bestTrialId: string | null;
}) {
  const [order, setOrder] = useState<SweepTrialOrder>('trial_index');
  const parameterColumns: TableColumn<SweepTrial>[] = trialParameterNames(trials).map((name) => ({
    key: `parameter:${name}`,
    label: <span className="mono">{name}</span>,
    className: 'mono',
    render: (trial) => formatParameter(trial.parameters[name]),
  }));
  return (
    <div className="sweep-trials" data-testid="sweep-trials">
      <label className="chart-selector">
        <span>{text.sort}</span>
        <select aria-label={text.sort} value={order} onChange={(event) => setOrder(event.target.value as SweepTrialOrder)}>
          <option value="trial_index">{text.sweepSortByTrial}</option>
          <option value="objective">{text.sweepSortByObjective}</option>
        </select>
      </label>
      <DataTable
        items={sortTrials(trials, order, objective.goal)}
        rowKey={(trial) => trial.id}
        isSelected={(trial) => trial.id === bestTrialId}
        empty={text.sweepNoTrials}
        columns={[
          { key: 'trial', label: text.sweepTrialIndex, className: 'mono', render: (trial) => textTemplates.sweepTrialRunName(trial.trialIndex) },
          ...parameterColumns,
          {
            key: 'objective',
            label: `${text.sweepObjectiveValue}（${objective.metric}）`,
            className: 'mono',
            render: (trial) => (trial.objectiveValue === null ? '—' : formatNumber(trial.objectiveValue)),
          },
          { key: 'state', label: text.sweepTrialState, render: (trial) => <SweepTrialStateBadge trial={trial} /> },
          {
            key: 'run',
            label: text.sweepTrialRun,
            render: (trial) => <Link to={`/projects/${projectId}/runs/${trial.runId}`}>{text.automationRun}</Link>,
          },
          {
            key: 'job',
            label: text.sweepTrialJob,
            render: (trial) => (
              <>
                <Link to={`/projects/${projectId}/jobs?job=${trial.jobId}`}>{text.automationJob}</Link>
                {trial.jobCancelRequested && <small> {text.cancelRequested}</small>}
              </>
            ),
          },
        ]}
      />
    </div>
  );
}
