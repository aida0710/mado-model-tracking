import type { OperationsAlert } from '@mmt/contracts';

/** What an alert is about, as a short label and the Project page that shows it. */
export interface OperationsAlertSubject {
  label: string;
  /** Path below /projects/:projectId. */
  pagePath: string;
}

function detailText(alert: OperationsAlert, key: string): string | null {
  const value = alert.detail[key];
  return value === null || value === undefined ? null : String(value);
}

export function describeOperationsAlertSubject(alert: OperationsAlert): OperationsAlertSubject {
  if (alert.kind === 'job.heartbeat_stale') {
    const runId = detailText(alert, 'runId');
    return {
      label: detailText(alert, 'runName') ?? alert.subjectId,
      pagePath: runId ? `runs/${encodeURIComponent(runId)}` : 'jobs',
    };
  }
  if (alert.kind === 'worker.offline') {
    const workerId = detailText(alert, 'workerId') ?? alert.subjectId;
    const hostname = detailText(alert, 'hostname');
    return { label: hostname ? `${workerId} (${hostname})` : workerId, pagePath: 'compute' };
  }
  return { label: detailText(alert, 'pluginName') ?? alert.subjectId, pagePath: 'plugins' };
}
