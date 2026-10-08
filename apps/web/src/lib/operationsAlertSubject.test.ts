import { describe, expect, it } from 'vitest';
import type { OperationsAlert } from '@mmt/contracts';
import { describeOperationsAlertSubject } from './operationsAlertSubject';

function alert(kind: OperationsAlert['kind'], detail: OperationsAlert['detail']): OperationsAlert {
  return {
    id: 'alert-1',
    projectId: 'project-1',
    kind,
    subjectId: 'subject-1',
    openedAt: '2026-10-08T00:00:00.000Z',
    resolvedAt: null,
    resolution: null,
    detail,
  };
}

describe('describeOperationsAlertSubject', () => {
  it('heartbeat途絶はRun名を示し、Run詳細へ移動する', () => {
    expect(
      describeOperationsAlertSubject(
        alert('job.heartbeat_stale', { runId: 'run/1', runName: 'Train' }),
      ),
    ).toEqual({ label: 'Train', pagePath: 'runs/run%2F1' });
  });

  it('worker停止はworker IDとhost名を示し、Compute画面へ移動する', () => {
    expect(
      describeOperationsAlertSubject(
        alert('worker.offline', { workerId: 'gpu-1', hostname: 'gpu-1.internal' }),
      ),
    ).toEqual({ label: 'gpu-1 (gpu-1.internal)', pagePath: 'compute' });
    expect(describeOperationsAlertSubject(alert('worker.offline', { hostname: null }))).toEqual({
      label: 'subject-1',
      pagePath: 'compute',
    });
  });

  it('plugin滞留はPlugin名を示し、Plugins画面へ移動する', () => {
    expect(
      describeOperationsAlertSubject(alert('plugin.delivery_stalled', { pluginName: 'Mado' })),
    ).toEqual({ label: 'Mado', pagePath: 'plugins' });
  });
});
