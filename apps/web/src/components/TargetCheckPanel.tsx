import { useEffect, useState } from 'react';
import { PlugZap } from 'lucide-react';
import type {
  ComputeTarget,
  ExecutionRuntimeKind,
  TargetCheck,
  TargetCheckGpu,
  TargetCheckItem,
} from '@mmt/contracts';
import { executionApi } from '../api/execution';
import { targetChecksApi } from '../api/targetChecks';
import { useMutation } from '../hooks/useMutation';
import { useQuery } from '../hooks/useQuery';
import { ResponsiveTable } from './ResponsiveTable';
import { ErrorNotice, Resource } from './Feedback';
import { StatusBadge } from './StatusBadge';
import { formatBytes, formatDate } from '../lib/format';
import { targetCheckHintFor, targetCheckItemLabel } from '../lib/computeTargetDisplay';
import {
  detectedCandidates,
  hasCandidateChanges,
  isCheckInProgress,
  type TargetCandidates,
} from '../lib/targetCheckCandidates';
import { text } from '../i18n/catalog';
import { targetCheckCodeHints, targetCheckOutcomeLabels } from '../i18n/compute';
import { runtimeLabels } from '../i18n/runtime';

// The worker polls for checks every 5 seconds and probes for up to two minutes.
const TARGET_CHECK_POLL_MS = 3000;

// Reuses the Job status colors: ok is green, ng red, the rest neutral.
const outcomeBadgeClass: Record<TargetCheckItem['status'], string> = {
  ok: 'status-finished',
  ng: 'status-failed',
  unavailable: 'status-queued',
  skipped: 'status-queued',
};

/**
 * The connection check of an ssh or local target, which a worker runs. A site is reached only by
 * its launcher, which checks the site's login in the site's details (SiteComputerDetails).
 */
export function TargetCheckPanel({
  target,
  onTargetSaved,
}: {
  target: ComputeTarget;
  onTargetSaved: () => void;
}) {
  const mutation = useMutation();
  const [isPolling, setPolling] = useState(false);
  const checks = useQuery(
    `target-checks:${target.id}`,
    (signal) => targetChecksApi.list(target.id, signal),
    isPolling ? TARGET_CHECK_POLL_MS : undefined,
  );
  const latest = checks.value?.[0];
  // Poll only while the latest check waits for a worker.
  useEffect(() => setPolling(isCheckInProgress(latest)), [latest]);
  const requestCheck = () =>
    void mutation.run(() => targetChecksApi.request(target.id)).then((created) => {
      if (created) checks.reload();
    });
  return (
    <section className="settings-section" data-testid="target-check-panel">
      <div className="section-heading">
        <h2>
          {text.targetCheck}: {target.name}
        </h2>
        <button
          className="button primary"
          disabled={mutation.pending || isCheckInProgress(latest)}
          onClick={requestCheck}
        >
          <PlugZap size={15} />
          {text.checkTarget}
        </button>
      </div>
      <p className="muted">{targetCheckHintFor(target.executor)}</p>
      <ErrorNotice message={mutation.error} />
      <Resource query={checks}>
        {() =>
          latest ? (
            <TargetCheckDetails check={latest} target={target} onTargetSaved={onTargetSaved} />
          ) : (
            <p className="state-message">{text.targetCheckNone}</p>
          )
        }
      </Resource>
    </section>
  );
}

function TargetCheckDetails({
  check,
  target,
  onTargetSaved,
}: {
  check: TargetCheck;
  target: ComputeTarget;
  onTargetSaved: () => void;
}) {
  const candidates = detectedCandidates(check);
  return (
    <>
      <dl className="details-list">
        <dt>{text.status}</dt>
        <dd>
          <StatusBadge status={check.status} />
        </dd>
        <dt>{text.targetCheckRequestedAt}</dt>
        <dd>{formatDate(check.createdAt)}</dd>
        {check.finishedAt && (
          <>
            <dt>{text.targetCheckFinishedAt}</dt>
            <dd>{formatDate(check.finishedAt)}</dd>
          </>
        )}
        {check.workerId && (
          <>
            <dt>{text.targetCheckWorker}</dt>
            <dd className="mono">{check.workerId}</dd>
          </>
        )}
        {check.result?.workDirectoryFreeBytes != null && (
          <>
            <dt>{text.targetCheckFreeSpace}</dt>
            <dd>{formatBytes(check.result.workDirectoryFreeBytes)}</dd>
          </>
        )}
      </dl>
      {isCheckInProgress(check) && <p className="notice">{text.targetCheckWaiting}</p>}
      {check.failureReason === 'no_worker' && (
        <p className="notice error">{text.targetCheckNoWorker}</p>
      )}
      {check.failureReason === 'claim_timeout' && (
        <p className="notice error">{text.targetCheckClaimTimeout}</p>
      )}
      {check.result && (
        <TargetCheckItems items={check.result.items} executor={target.executor} />
      )}
      {check.result?.gpus && <DetectedGpus gpus={check.result.gpus} />}
      {candidates && (
        <TargetCandidateEditor
          key={check.id}
          target={target}
          detected={candidates}
          onSaved={onTargetSaved}
        />
      )}
    </>
  );
}

function TargetCheckItems({
  items,
  executor,
}: {
  items: TargetCheckItem[];
  executor: ComputeTarget['executor'];
}) {
  return (
    <ResponsiveTable
      rows={items}
      rowKey={(item) => item.name}
      columns={[
        {
          key: 'item',
          priority: 'primary',
          header: text.targetCheckItem,
          render: (item) => targetCheckItemLabel(item.name, executor),
        },
        {
          key: 'outcome',
          priority: 'primary',
          header: text.targetCheckOutcome,
          render: (item) => (
            <span className={`status-badge ${outcomeBadgeClass[item.status]}`}>
              {targetCheckOutcomeLabels[item.status]}
            </span>
          ),
        },
        {
          key: 'detail',
          priority: 'secondary',
          header: text.targetCheckDetail,
          className: 'mono',
          render: (item) => item.detail ?? '—',
        },
        {
          key: 'action',
          priority: 'secondary',
          header: text.targetCheckAction,
          render: (item) => (item.code ? targetCheckCodeHints[item.code] : ''),
        },
      ]}
    />
  );
}

function DetectedGpus({ gpus }: { gpus: TargetCheckGpu[] }) {
  return (
    <>
      <h3>{text.detectedGpus}</h3>
      <ResponsiveTable
        rows={gpus}
        rowKey={(gpu) => gpu.uuid}
        empty={text.noDetectedGpus}
        columns={[
          {
            key: 'index',
            priority: 'primary',
            header: text.gpuIndex,
            className: 'mono',
            render: (gpu) => gpu.index,
          },
          { key: 'name', priority: 'primary', header: text.gpuName, render: (gpu) => gpu.name },
          {
            key: 'memory',
            priority: 'secondary',
            header: text.gpuMemory,
            className: 'mono',
            render: (gpu) => `${gpu.memoryTotalMiB} MiB`,
          },
          {
            key: 'uuid',
            priority: 'secondary',
            header: text.gpuUuid,
            className: 'mono',
            render: (gpu) => gpu.uuid,
          },
        ]}
      />
    </>
  );
}

// Detected values are only offered; the target changes when the administrator saves.
function TargetCandidateEditor({
  target,
  detected,
  onSaved,
}: {
  target: ComputeTarget;
  detected: TargetCandidates;
  onSaved: () => void;
}) {
  const mutation = useMutation();
  const [selected, setSelected] = useState<TargetCandidates>(detected);
  const [isSaved, setSaved] = useState(false);
  const toggle = <K extends keyof TargetCandidates>(field: K, value: TargetCandidates[K][number]) => {
    setSaved(false);
    setSelected((previous) => {
      const values = previous[field] as string[];
      return {
        ...previous,
        [field]: values.includes(value) ? values.filter((entry) => entry !== value) : [...values, value],
      };
    });
  };
  const save = () =>
    void mutation
      .run(() =>
        executionApi.updateTarget(target.id, {
          gpuIds: selected.gpuIds,
          runtimeKinds: selected.runtimeKinds,
        }),
      )
      .then((saved) => {
        if (!saved) return;
        setSaved(true);
        onSaved();
      });
  return (
    <div className="target-check-candidates">
      <h3>{text.targetCheckCandidates}</h3>
      <p className="muted">{text.targetCheckCandidatesHint}</p>
      <ErrorNotice message={mutation.error} />
      <fieldset>
        <legend>
          {text.gpuIds}（{text.targetCheckCurrent}: {target.gpuIds.join(', ') || text.cpuOnly}）
        </legend>
        {detected.gpuIds.length === 0 && <span className="muted">{text.noDetectedGpus}</span>}
        {detected.gpuIds.map((gpuId) => (
          <label className="checkbox-field" key={gpuId}>
            <input
              type="checkbox"
              checked={selected.gpuIds.includes(gpuId)}
              onChange={() => toggle('gpuIds', gpuId)}
            />
            {gpuId}
          </label>
        ))}
      </fieldset>
      <fieldset>
        <legend>
          {text.runtimeKinds}（{text.targetCheckCurrent}:{' '}
          {target.runtimeKinds.map((kind) => runtimeLabels[kind]).join(', ')}）
        </legend>
        {detected.runtimeKinds.map((kind: ExecutionRuntimeKind) => (
          <label className="checkbox-field" key={kind}>
            <input
              type="checkbox"
              checked={selected.runtimeKinds.includes(kind)}
              onChange={() => toggle('runtimeKinds', kind)}
            />
            {runtimeLabels[kind]}
          </label>
        ))}
      </fieldset>
      <button
        className="button"
        disabled={
          mutation.pending ||
          selected.runtimeKinds.length === 0 ||
          !hasCandidateChanges(target, selected)
        }
        onClick={save}
      >
        {text.saveTargetCandidates}
      </button>
      {isSaved && (
        <p className="notice success" role="status">
          {text.targetCheckCandidatesSaved}
        </p>
      )}
    </div>
  );
}
