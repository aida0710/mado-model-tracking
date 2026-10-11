import { describe, expect, it } from 'vitest';
import type { DatasetVersion, ModelVersion } from '@mmt/contracts';
import type { HookCatalog } from '../types/hooks';
import type { FormValues } from '../types/form';
import { computeTarget, executionCatalog, siteTarget } from '../../tests/fixtures/execution';
import {
  INHERIT_MODEL_VERSION,
  buildHookInput,
  createHookValues,
  hookFilterFields,
  updateHookValues,
} from './hookInput';

const datasetVersion = executionCatalog.datasetVersions[0]!;
const shards: DatasetVersion = {
  ...datasetVersion,
  id: 'shards-v1',
  name: 'shards',
  contentKind: 'artifacts',
  fileCount: 520,
  totalSize: 520 * 1024 ** 3,
};
const qwenVersion = { id: 'qwen-v1', modelId: 'model', family: 'Qwen3', version: '1' } as ModelVersion;
const llamaVersion = { ...qwenVersion, id: 'llama-v1', family: 'Llama' };
const catalog: HookCatalog = {
  registry: {
    ...executionCatalog,
    modelVersions: [qwenVersion, llamaVersion],
    datasetVersions: [datasetVersion, shards],
  },
  targets: [computeTarget, siteTarget],
};
const values: FormValues = {
  ...createHookValues(),
  name: ' Evaluate on demand ',
  experimentId: 'experiment',
  codeVersionId: 'code-v1',
  targetId: 'target',
  gpuIds: ['0'],
  inputDatasetVersionIds: ['dataset-v1'],
  parameters: '{"temperature":0}',
  tags: '{"suite":"hooks"}',
};
const siteValues: FormValues = {
  ...values,
  targetId: 'site',
  gpuIds: [],
  gpuCount: '1',
  walltime: '12:00:00',
  arraySize: '64',
  inputDatasetVersionIds: ['shards-v1'],
  datasetPartitionVersionId: 'shards-v1',
  retryOnTimeout: 'true',
};

describe('フックの作成の入力', () => {
  it('手動のフックはsshのtargetにGPU IDを送り、siteだけの項目と絞り込みを送らない', () => {
    const input = buildHookInput(values, catalog);
    expect(input).toEqual({
      name: 'Evaluate on demand',
      trigger: 'manual',
      filter: {},
      template: {
        experimentId: 'experiment',
        kind: 'inference',
        codeVersionId: 'code-v1',
        modelVersionId: null,
        inheritModelVersion: false,
        inputDatasetVersionIds: ['dataset-v1'],
        inheritOutputDatasets: false,
        parameters: { temperature: 0 },
        tags: { suite: 'hooks' },
        targetId: 'target',
        gpuIds: ['0'],
        maxAttempts: 1,
        allowChildJobs: false,
      },
      concurrency: 'queue',
      maxStartsPerHour: 60,
    });
  });

  it('siteにはGPU数・制限時間・array・分ける入力・自動の再実行を送り、GPU IDは送らない', () => {
    const template = buildHookInput(siteValues, catalog).template;
    expect(template).toMatchObject({
      targetId: 'site',
      gpuCount: 1,
      walltimeSeconds: 12 * 60 * 60,
      arraySize: 64,
      datasetPartitionVersionId: 'shards-v1',
      retryOnTimeout: true,
    });
    expect(template).not.toHaveProperty('gpuIds');
    expect(template).not.toHaveProperty('retryOnFailure');
  });

  it('分ける入力はarrayの個数とファイルを持つ入力のバージョンが必要', () => {
    expect(() => buildHookInput({ ...siteValues, arraySize: '' }, catalog)).toThrow('arrayの個数');
    expect(() =>
      buildHookInput(
        { ...siteValues, inputDatasetVersionIds: ['dataset-v1'], datasetPartitionVersionId: 'dataset-v1' },
        catalog,
      ),
    ).toThrow('ファイルを持つバージョン');
  });

  it('きっかけごとに意味のある絞り込みだけを送る', () => {
    const filtered = {
      ...values,
      filterModelFamilies: ['Qwen3'],
      filterExperimentIds: ['experiment'],
      filterRunKinds: ['training'],
      filterRunStatuses: ['finished'],
      filterTags: '{"mmt.arrayGroupId":"group"}',
    };
    expect(buildHookInput({ ...filtered, trigger: 'run_finished' }, catalog).filter).toEqual({
      modelFamilies: ['Qwen3'],
      experimentIds: ['experiment'],
      runKinds: ['training'],
      runStatuses: ['finished'],
      tags: { 'mmt.arrayGroupId': 'group' },
    });
    // A registration knows its training Run but no end status; a checkpoint's Run has not ended.
    expect(buildHookInput({ ...filtered, trigger: 'model_registered' }, catalog).filter).toEqual({
      modelFamilies: ['Qwen3'],
      experimentIds: ['experiment'],
      runKinds: ['training'],
      tags: { 'mmt.arrayGroupId': 'group' },
    });
    expect(buildHookInput({ ...filtered, trigger: 'checkpoint_saved' }, catalog).filter).not.toHaveProperty(
      'runStatuses',
    );
    expect(buildHookInput({ ...filtered, trigger: 'manual' }, catalog).filter).toEqual({});
    expect(hookFilterFields('webhook')).toEqual([]);
  });

  it('きっかけのRunのモデルバージョンは、Runから起きるきっかけ（終了・arrayの終了・checkpoint）だけが引き継ぐ', () => {
    const inheriting = { ...values, modelVersionId: INHERIT_MODEL_VERSION };
    for (const trigger of ['run_finished', 'array_finished', 'checkpoint_saved'])
      expect(buildHookInput({ ...inheriting, trigger }, catalog).template).toMatchObject({
        modelVersionId: null,
        inheritModelVersion: true,
      });
    const updated = updateHookValues({
      previous: { ...inheriting, trigger: 'run_finished' },
      next: { ...inheriting, trigger: 'webhook' },
      catalog,
    });
    expect(updated.modelVersionId).toBe('');
  });

  it('モデルバージョンの登録では、固定のバージョンを送らずに登録されたバージョンで起動する', () => {
    const template = buildHookInput(
      { ...values, trigger: 'model_registered', modelVersionId: 'qwen-v1' },
      catalog,
    ).template;
    expect(template).toMatchObject({ modelVersionId: null, inheritModelVersion: false });
  });

  it('コードバージョンが対応しないモデル系列のバージョンや絞り込みを拒否する', () => {
    expect(buildHookInput({ ...values, modelVersionId: 'qwen-v1' }, catalog).template.modelVersionId).toBe(
      'qwen-v1',
    );
    expect(() => buildHookInput({ ...values, modelVersionId: 'llama-v1' }, catalog)).toThrow();
    expect(() =>
      buildHookInput({ ...values, trigger: 'model_registered', filterModelFamilies: ['Llama'] }, catalog),
    ).toThrow();
    expect(() => buildHookInput({ ...values, kind: 'training' }, catalog)).toThrow();
  });

  it('webhookには署名の形式を、checkpointのk個ごとにはkを送る', () => {
    expect(buildHookInput({ ...values, trigger: 'webhook', webhookSignature: 'mmt' }, catalog)).toMatchObject({
      trigger: 'webhook',
      webhookSignature: 'mmt',
    });
    const everyK = { ...values, trigger: 'checkpoint_saved', checkpointMode: 'every_k', checkpointEvery: '5' };
    expect(buildHookInput(everyK, catalog)).toMatchObject({ checkpointMode: 'every_k', checkpointEvery: 5 });
    expect(() => buildHookInput({ ...everyK, checkpointEvery: '' }, catalog)).toThrow();
    expect(buildHookInput({ ...values, checkpointMode: 'latest' }, catalog)).not.toHaveProperty(
      'checkpointMode',
    );
  });

  it('起動回数の上限と最大試行回数は契約の範囲だけを受け付ける', () => {
    expect(() => buildHookInput({ ...values, maxStartsPerHour: '10001' }, catalog)).toThrow('10000');
    expect(() => buildHookInput({ ...values, maxStartsPerHour: '0' }, catalog)).toThrow();
    expect(() => buildHookInput({ ...values, maxAttempts: '101' }, catalog)).toThrow();
  });

  it.each(['mmt.hookId', 'automation.ruleId'])('Runに付けるtagに予約tag %s を使えない', (key) => {
    expect(() => buildHookInput({ ...values, tags: JSON.stringify({ [key]: 'x' }) }, catalog)).toThrow(key);
  });

  it('名前、実験、無効なtargetを確かめる', () => {
    expect(() => buildHookInput({ ...values, name: ' ' }, catalog)).toThrow('名前');
    expect(() => buildHookInput({ ...values, experimentId: 'outside' }, catalog)).toThrow();
    expect(() =>
      buildHookInput(values, { ...catalog, targets: [{ ...computeTarget, enabled: false }] }),
    ).toThrow();
  });

  it('コードバージョンを変えるとtargetとGPUを外し、入力から外したバージョンはarrayで分けるバージョンからも外す', () => {
    expect(
      updateHookValues({ previous: values, next: { ...values, kind: 'training' }, catalog }),
    ).toMatchObject({ codeVersionId: '', targetId: '', gpuIds: [] });
    expect(
      updateHookValues({
        previous: siteValues,
        next: { ...siteValues, inputDatasetVersionIds: ['dataset-v1'] },
        catalog,
      }).datasetPartitionVersionId,
    ).toBe('');
  });
});
