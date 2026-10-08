import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Pause, Play, Square } from 'lucide-react';
import type { Sweep, SweepPatch, SweepStatus } from '@mmt/contracts';
import { sweepsApi } from '../../api/sweeps';
import { useMutation } from '../../hooks/useMutation';
import { formatNumber } from '../../lib/format';
import { isSweepEnded } from '../../lib/sweepTrials';
import { ConfirmDialog } from '../ConfirmDialog';
import { ErrorNotice } from '../Feedback';
import { FormDialog } from '../FormDialog';
import { DetailsList, KeyValues } from '../JsonDetails';
import {
  sweepGoalLabels,
  sweepStatusLabels,
  sweepStatusReasonLabels,
  sweepTrialStateLabels,
} from '../../i18n/sweeps';
import { text, textTemplates } from '../../i18n/catalog';

// Reuses the Job status colors: a paused sweep reads like waiting work.
const STATUS_BADGE_CLASSES: Record<SweepStatus, string> = {
  running: 'status-running',
  paused: 'status-queued',
  finished: 'status-finished',
  canceled: 'status-canceled',
  failed: 'status-failed',
};

export function SweepStatusBadge({ status }: { status: SweepStatus }) {
  return (
    <span className={`status-badge ${STATUS_BADGE_CLASSES[status]}`}>
      <span aria-hidden="true">●</span>
      {sweepStatusLabels[status]}
    </span>
  );
}

type SweepDialog = 'cancel' | 'limits' | null;

/**
 * The sweep's state, why it is in it, how far it got and its best trial. Pause, resume, cancel and
 * the limits change are shown only to `canControl` (the creator or a Project admin).
 */
export function SweepSummary({
  projectId,
  sweep,
  canControl,
  onChanged,
}: {
  projectId: string;
  sweep: Sweep;
  canControl: boolean;
  onChanged: () => void;
}) {
  const [dialog, setDialog] = useState<SweepDialog>(null);
  const [cancelRunningTrials, setCancelRunningTrials] = useState(false);
  const mutation = useMutation();
  const counts = sweep.trialCounts;
  const isResumable = sweep.status === 'paused' && sweep.statusReason !== 'task_revision_changed';
  const best = sweep.bestTrial;
  const act = (operation: () => Promise<unknown>) =>
    void mutation.run(operation).then((result) => {
      if (result !== undefined) onChanged();
    });

  return (
    <section className="sweep-summary" data-testid="sweep-summary">
      <div className="sweep-summary-status">
        <SweepStatusBadge status={sweep.status} />
        {sweep.statusReason && (
          <span className="muted" data-testid="sweep-status-reason">
            {text.sweepStatusReason}: {sweepStatusReasonLabels[sweep.statusReason]}
          </span>
        )}
        {canControl && !isSweepEnded(sweep) && (
          <div className="sweep-actions">
            {sweep.status === 'running' && (
              <button className="button small" disabled={mutation.pending}
                onClick={() => act(() => sweepsApi.pause(projectId, sweep.id))}>
                <Pause size={13} />{text.sweepPause}
              </button>
            )}
            {isResumable && (
              <button className="button small primary" disabled={mutation.pending}
                onClick={() => act(() => sweepsApi.resume(projectId, sweep.id))}>
                <Play size={13} />{text.sweepResume}
              </button>
            )}
            <button className="button small" disabled={mutation.pending} onClick={() => setDialog('limits')}>
              {text.sweepChangeLimits}
            </button>
            <button className="button small danger" disabled={mutation.pending} onClick={() => setDialog('cancel')}>
              <Square size={13} />{text.sweepCancel}
            </button>
          </div>
        )}
      </div>
      {sweep.statusReason === 'task_revision_changed' && <p className="muted">{text.sweepResumeUnavailable}</p>}
      <ErrorNotice message={mutation.error} />
      <div className="sweep-progress" aria-label={text.sweepProgress}>
        <span>{text.sweepProgress}</span>
        <progress max={sweep.maxTrials} value={counts.total} />
        <span className="mono" data-testid="sweep-trial-progress">{textTemplates.sweepTrialProgress(counts.total, sweep.maxTrials)}</span>
        <span className="sweep-state-counts">
          {(['queued', 'running', 'finished', 'early_stopped', 'failed', 'canceled'] as const)
            .filter((state) => counts[state] > 0)
            .map((state) => <span key={state}>{sweepTrialStateLabels[state]} {counts[state]}</span>)}
        </span>
      </div>
      <div className="sweep-best" data-testid="sweep-best-trial">
        <h3>{text.sweepBestTrial}</h3>
        {best ? (
          <>
            <DetailsList entries={[
              [text.sweepTrialIndex, <Link to={`/projects/${projectId}/runs/${best.runId}`}>{textTemplates.sweepTrialRunName(best.trialIndex)}</Link>],
              [`${sweep.objective.metric}（${sweepGoalLabels[sweep.objective.goal]}）`,
                <span className="mono">{best.objectiveValue === null ? '—' : formatNumber(best.objectiveValue)}</span>],
            ]} />
            <KeyValues values={best.parameters} />
          </>
        ) : (
          <p className="muted">{text.sweepNoBestTrial}</p>
        )}
      </div>
      {dialog === 'cancel' && (
        <ConfirmDialog
          title={text.sweepCancel}
          confirmLabel={text.sweepCancel}
          destructive
          message={
            <>
              {text.sweepCancelConfirm}
              <label className="checkbox-field">
                <input type="checkbox" checked={cancelRunningTrials}
                  onChange={(event) => setCancelRunningTrials(event.target.checked)} />
                {text.sweepCancelRunning}
              </label>
            </>
          }
          onConfirm={() => sweepsApi.cancel(projectId, sweep.id, { cancelRunningTrials })}
          onConfirmed={() => { setDialog(null); onChanged(); }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'limits' && (
        <FormDialog
          title={text.sweepChangeLimits}
          fields={[
            { name: 'maxTrials', label: text.sweepMaxTrials, type: 'number', min: 1, required: true, defaultValue: String(sweep.maxTrials) },
            { name: 'parallelism', label: text.sweepParallelism, type: 'number', min: 1, required: true, defaultValue: String(sweep.parallelism) },
          ]}
          onSubmit={(values) => {
            const patch: SweepPatch = {};
            const maxTrials = Number(values.maxTrials);
            const parallelism = Number(values.parallelism);
            if (maxTrials !== sweep.maxTrials) patch.maxTrials = maxTrials;
            if (parallelism !== sweep.parallelism) patch.parallelism = parallelism;
            return sweepsApi.update(projectId, sweep.id, patch);
          }}
          onSaved={() => { setDialog(null); onChanged(); }}
          onClose={() => setDialog(null)}
        />
      )}
    </section>
  );
}
