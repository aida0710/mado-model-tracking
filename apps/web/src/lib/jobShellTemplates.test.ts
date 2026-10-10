import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { JOB_SHELL_TEMPLATES, findJobShellTemplate } from './jobShellTemplates';
import { jobShellTemplateLabels } from '../i18n/siteComputers';

const examplePath = (key: string) =>
  new URL(`../../../../deploy/sites/examples/${key}/job.sh`, import.meta.url);

describe('job shellの雛形', () => {
  it('deploy/sites/examplesの6つのjob.shを、書き換えずにそのまま使う', () => {
    expect(JOB_SHELL_TEMPLATES.map((template) => template.key)).toEqual([
      'pbs',
      'slurm',
      'grid-engine',
      'fujitsu-tcs',
      'direct-docker',
      'direct-apptainer',
    ]);
    for (const template of JOB_SHELL_TEMPLATES) {
      expect(template.content).toBe(readFileSync(examplePath(template.key), 'utf8'));
      expect(template.content.startsWith('#!/bin/sh\n')).toBe(true);
      expect(jobShellTemplateLabels[template.key]).toBeTruthy();
    }
  });

  it('スケジューラの雛形は待ち行列から外すコマンドを持ち、arrayを1回で投入し、GPUはスケジューラが決める', () => {
    for (const key of ['pbs', 'slurm', 'grid-engine', 'fujitsu-tcs']) {
      const template = findJobShellTemplate(key);
      expect(template?.cancelCommand).toContain('"$MMT_SCHEDULER_JOB_ID"');
      expect(template).toMatchObject({ supportsArray: true, gpuAssignment: 'scheduler' });
    }
    expect(findJobShellTemplate('fujitsu-tcs')?.cancelCommand).toBe('pjdel "$MMT_SCHEDULER_JOB_ID"');
  });

  it('スケジューラの無いホストの雛形は取消コマンドもarrayも無く、runnerが空いたGPUを選ぶ', () => {
    expect(findJobShellTemplate('direct-docker')).toMatchObject({
      cancelCommand: null,
      supportsArray: false,
      gpuAssignment: 'lease',
      runtimeKinds: ['docker'],
    });
    expect(findJobShellTemplate('direct-apptainer')?.runtimeKinds).toEqual(['apptainer']);
  });

  it('知らない名前の雛形は無い', () => {
    expect(findJobShellTemplate('')).toBeUndefined();
    expect(findJobShellTemplate('lsf')).toBeUndefined();
  });
});
