import { describe, expect, it } from 'vitest';
import type { ComputeTarget, ExperimentTask, Model } from '@mmt/contracts';
import type { ExecutionCatalog } from '../types/executionCatalog';
import type { FormValues } from '../types/form';
import { dockerCodeVersion } from '../../tests/fixtures/execution';
import {
  buildTaskInput, buildTaskLaunchInput, createTaskValues, getOutputModelCandidates, updateTaskValues,
} from './taskInput';

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

const trainingCode = { ...code, id: 'training-code', taskTypes: ['training' as const], supportedModelFamilies: ['Qwen3'] };
const otherFamilyCode = { ...trainingCode, id: 'other-code', supportedModelFamilies: ['Llama'] };
const inferenceCode = { ...code, id: 'inference-code', supportedModelFamilies: ['Qwen3'] };
const model = (id: string, family: string) => ({ id, name: id, family }) as Model;
const trainingCatalog = { ...catalog, models: [model('qwen', 'Qwen3'), model('llama', 'Llama')],
  codeVersions: [trainingCode, otherFamilyCode, inferenceCode] } as ExecutionCatalog;
const trainingValues: FormValues = { ...values, kind: 'training', codeVersionId: trainingCode.id,
  outputModelEnabled: 'true', outputModelTarget: 'existing', outputModelId: 'qwen' };
const buildTraining = (override: FormValues, task?: ExperimentTask) =>
  buildTaskInput({ values: { ...trainingValues, ...override }, catalog: trainingCatalog, targets: [target], task });

describe('Taskの出力モデル設定', () => {
  it('training・finetuningでは登録先を送り、それ以外の種別では送らない', () => {
    expect(buildTraining({}).outputModel).toEqual({ modelId: 'qwen', createModel: null, artifactPath: 'model', defaultCodeVersionId: null });
    const finetuningCatalog = { ...trainingCatalog, codeVersions: [{ ...trainingCode, taskTypes: ['finetuning' as const] }] };
    expect(buildTaskInput({ values: { ...trainingValues, kind: 'finetuning' }, catalog: finetuningCatalog, targets: [target] }).outputModel)
      .toMatchObject({ modelId: 'qwen' });
    expect(buildTaskInput({ values: { ...values, ...trainingValues, kind: 'inference', codeVersionId: code.id }, catalog, targets: [target] }))
      .not.toHaveProperty('outputModel');
  });
  it('成功時の登録をoffにすると登録先をnullで保存する', () => {
    expect(buildTraining({ outputModelEnabled: 'false', outputModelId: '' }).outputModel).toBeNull();
  });
  it('種別をtraining以外へ変えたTaskの更新は保存済みの登録先をnullで解除する', () => {
    const saved = { ...task, kind: 'training' as const, outputModel: { modelId: 'qwen', createModel: null, artifactPath: 'model' } };
    expect(buildTaskInput({ values: { ...values, ...trainingValues, kind: 'inference', codeVersionId: code.id }, catalog, targets: [target], task: saved }).outputModel).toBeNull();
  });
  it('既存モデルと新しいモデルの指定は排他で、選んだ方だけを送る', () => {
    expect(buildTraining({ outputModelName: 'ignored', outputModelFamily: 'Qwen3' }).outputModel)
      .toMatchObject({ modelId: 'qwen', createModel: null });
    expect(buildTraining({ outputModelTarget: 'create', outputModelName: ' new-model ', outputModelFamily: 'Qwen3' }).outputModel)
      .toMatchObject({ modelId: null, createModel: { name: 'new-model', family: 'Qwen3' } });
    expect(() => buildTraining({ outputModelTarget: 'create', outputModelName: '', outputModelFamily: 'Qwen3' })).toThrow();
    expect(() => buildTraining({ outputModelId: '' })).toThrow();
  });
  it('Artifactのパスは相対パスだけを受け付け、末尾の/は外して送る', () => {
    expect(buildTraining({ outputModelArtifactPath: ' model/weights/ ' }).outputModel?.artifactPath).toBe('model/weights');
    for (const outputModelArtifactPath of ['', '/model', '../model', 'model//weights', 'model\\weights'])
      expect(() => buildTraining({ outputModelArtifactPath })).toThrow();
  });
  it('系列の候補は選択中の学習コード版の対応系列に絞り、対応外の系列は保存しない', () => {
    expect(getOutputModelCandidates(trainingCatalog.models, trainingCode).map((item) => item.id)).toEqual(['qwen']);
    expect(() => buildTraining({ outputModelId: 'llama' })).toThrow();
    expect(() => buildTraining({ outputModelTarget: 'create', outputModelName: 'new', outputModelFamily: 'Llama' })).toThrow();
  });
  it('学習コード版を変えると、新しい版が扱えない登録先と既定コード版を解除する', () => {
    const selected = { ...trainingValues, outputModelFamily: 'Qwen3', outputModelDefaultCodeVersionId: inferenceCode.id };
    const updated = updateTaskValues({ previous: selected, next: { ...selected, codeVersionId: otherFamilyCode.id },
      catalog: trainingCatalog, targets: [target] });
    expect(updated).toMatchObject({ outputModelId: '', outputModelFamily: '', outputModelDefaultCodeVersionId: '' });
  });
  it('既定コード版は登録する系列に対応する版だけを受け付ける', () => {
    expect(buildTraining({ outputModelDefaultCodeVersionId: inferenceCode.id }).outputModel?.defaultCodeVersionId).toBe(inferenceCode.id);
    expect(() => buildTraining({ outputModelDefaultCodeVersionId: otherFamilyCode.id })).toThrow();
  });
  it('画面にない版の命名規則とmetadataは編集後も保存済みの値を残す', () => {
    const saved = { ...task, kind: 'training' as const, codeVersionId: trainingCode.id, outputModel: {
      modelId: 'qwen', createModel: null, artifactPath: 'model', versionTemplate: 'run-{runId}', metadata: { owner: 'team' } } };
    expect(buildTaskInput({ values: createTaskValues(saved), catalog: trainingCatalog, targets: [target], task: saved }).outputModel)
      .toEqual({ ...saved.outputModel, defaultCodeVersionId: null });
  });
  it('起動は出力設定を送らず、登録先が消えたTaskでも起動入力を作れる', () => {
    const saved = { ...task, kind: 'training' as const, codeVersionId: trainingCode.id,
      outputModel: { modelId: 'deleted', createModel: null, artifactPath: 'model' } };
    const input = buildTaskLaunchInput({ task: saved, mode: 'run', values: createTaskValues(saved), catalog: trainingCatalog, targets: [target] });
    expect(input).not.toHaveProperty('outputModel');
  });
});
