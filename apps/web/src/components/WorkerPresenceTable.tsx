import type { ComputeTarget, WorkerPresence } from '@mmt/contracts';
import { DataTable } from './DataTable';
import { formatDate } from '../lib/format';
import { text } from '../i18n/catalog';

// Reuses the Job status colors: finished is the green badge and failed the red one.
const workerStatusBadgeClass: Record<WorkerPresence['status'], string> = {
  online: 'status-finished',
  offline: 'status-failed',
};

function WorkerStatusBadge({ status }: { status: WorkerPresence['status'] }) {
  return (
    <span
      className={`status-badge ${workerStatusBadgeClass[status]}`}
      title={status === 'offline' ? text.workerOfflineHint : undefined}
    >
      <span aria-hidden="true">●</span>
      {status === 'online' ? text.workerOnline : text.workerOffline}
    </span>
  );
}

export function WorkerPresenceTable({
  workers,
  targets,
}: {
  workers: WorkerPresence[];
  targets: ComputeTarget[];
}) {
  const targetName = (id: string) => targets.find((target) => target.id === id)?.name ?? id;
  return (
    <DataTable
      items={workers}
      rowKey={(worker) => `${worker.tokenId}:${worker.workerId}`}
      empty={text.noWorkers}
      columns={[
        {
          key: 'worker',
          label: text.workerId,
          className: 'mono',
          render: (worker) => worker.workerId,
        },
        {
          key: 'status',
          label: text.workerStatus,
          render: (worker) => <WorkerStatusBadge status={worker.status} />,
        },
        {
          key: 'version',
          label: text.workerVersion,
          className: 'mono',
          render: (worker) => worker.version ?? '—',
        },
        {
          key: 'hostname',
          label: text.workerHostname,
          render: (worker) => worker.hostname ?? '—',
        },
        {
          key: 'token',
          label: text.workerToken,
          render: (worker) => worker.tokenName,
        },
        {
          key: 'targets',
          label: text.workerTargets,
          render: (worker) => worker.targetIds?.map(targetName).join(', ') ?? text.workerAllTargets,
        },
        {
          key: 'lastSeen',
          label: text.workerLastSeen,
          render: (worker) => formatDate(worker.lastSeenAt),
        },
        {
          key: 'activeJobs',
          label: text.workerActiveJobs,
          className: 'mono',
          render: (worker) =>
            worker.parallelJobs
              ? `${worker.activeJobCount} / ${worker.parallelJobs}`
              : worker.activeJobCount,
        },
      ]}
    />
  );
}
