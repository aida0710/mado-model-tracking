import { describe, expect, it } from 'vitest';
import type { ComputeTarget, ExperimentTask } from '@mmt/contracts';
import type { ExecutionCatalog } from '../types/executionCatalog';
import type { FormValues } from '../types/form';
import { dockerCodeVersion } from '../../tests/fixtures/execution';
import { buildTaskInput, buildTaskLaunchInput, createTaskValues, updateTaskValues } from './taskInput';

const code = { ...dockerCodeVersion, taskTypes: ['inference' as const], testEntrypoint: ['python', '-m', 'unittest'] };
const target: ComputeTarget = { id: 'target', name: 'Compute', host: 'example.invalid', port: 22,
  username: 'test', sshKeyPath: '', knownHostsPath: '', workDirectory: '/work', pythonExecutable: 'python',
  runtimeKinds: ['docker'], gpuIds: ['0'], maxConcurrentJobs: 1, enabled: true, executor: 'ssh' };
const catalog = { experiments: [{ id: 'experiment' }], codes: [], models: [], datasets: [], runs: [],
  codeVersions: [code], modelVersions: [], datasetVersions: [] } as unknown as ExecutionCatalog;
const task: ExperimentTask = { id: 'task', projectId: 'project', experimentId: 'experiment',
  name: 'Inference', description: '', kind: 'inference', codeVersionId: code.id, modelVersionId: null,
  inputDatasetVersionIds: [], parameters: { batch_size: 2 }, tags: {}, targetId: target.id, gpuIds: [],
  revision: 4, createdAt: '', updatedAt: '' };
const values = createTaskValues(task);

describe('Taskの保存と起動', () => {
  it('保存したrevisionとtestモードを送り、コードの再選択で起動版を取り違えない', () => {
    const input = buildTaskLaunchInput({ task, mode: 'test', values: { ...values, codeVersionId: 'other' }, catalog, targets: [target] });
    expect(input).toMatchObject({ expectedRevision: 4, executionMode: 'test', targetId: 'target', gpuIds: [], modelVersionId: null });
    expect(input).not.toHaveProperty('codeVersionId');
  });
  it('testコマンドが保存されていない版をtest起動しない', () => {
    expect(() => buildTaskLaunchInput({ task, mode: 'test', values, catalog: {
      ...catalog, codeVersions: [{ ...code, testEntrypoint: [] }],
    }, targets: [target] })).toThrow();
  });
  it('targetなしのTaskを保存できるが起動には有効な対応targetを要求する', () => {
    expect(buildTaskInput({ values: { ...values, targetId: '' }, catalog, targets: [] }).targetId).toBeNull();
    expect(() => buildTaskLaunchInput({ task, mode: 'run', values: { ...values, targetId: '' }, catalog, targets: [] })).toThrow();
    expect(() => buildTaskInput({ values, catalog, targets: [{ ...target, enabled: false }] })).toThrow();
  });
  it('別Projectの実験・model・datasetとtarget外GPUを拒否する', () => {
    const overrides: FormValues[] = [{ experimentId: 'outside' }, { modelVersionId: 'outside' },
      { inputDatasetVersionIds: ['outside'] }, { gpuIds: ['4'] }];
    for (const override of overrides)
      expect(() => buildTaskInput({ values: { ...values, ...override }, catalog, targets: [target] })).toThrow();
  });
  it('実行種別が変わると非対応のコード版を解除し、target変更ではGPUを解除する', () => {
    expect(updateTaskValues({ previous: values, next: { ...values, kind: 'training' }, catalog, targets: [target] }).codeVersionId).toBe('');
    expect(updateTaskValues({ previous: { ...values, gpuIds: ['0'] }, next: { ...values, targetId: '', gpuIds: ['0'] }, catalog, targets: [target] }).gpuIds).toEqual([]);
  });
});
