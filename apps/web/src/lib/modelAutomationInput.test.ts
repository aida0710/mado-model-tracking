import { describe, expect, it } from 'vitest';
import { computeTarget, executionCatalog } from '../../tests/fixtures/execution';
import {
  buildAutomationRuleInput,
  createAutomationValues,
  updateAutomationValues,
} from './modelAutomationInput';
import { canManageAutomationRules } from './automationPermissions';

const catalog = { registry: executionCatalog, targets: [computeTarget] };
const values = {
  ...createAutomationValues(['Qwen3']),
  name: 'Evaluate new models',
  experimentId: 'experiment',
  codeVersionId: 'code-v1',
  targetId: 'target',
  gpuIds: ['0'],
  inputDatasetVersionIds: ['dataset-v1'],
  parameters: '{"temperature":0}',
  tags: '{"suite":"test"}',
};
describe('モデル自動実行ルールの入力', () => {
  it('実験・コード版・データセット版・Targetを固定して登録する', () => {
    expect(buildAutomationRuleInput(values, catalog)).toMatchObject({
      experimentId: 'experiment',
      codeVersionId: 'code-v1',
      targetId: 'target',
      inputDatasetVersionIds: ['dataset-v1'],
      parameters: { temperature: 0 },
      tags: { suite: 'test' },
    });
  });
  it('未対応のモデル系列と学習種別を拒否する', () => {
    expect(() =>
      buildAutomationRuleInput({ ...values, modelFamilies: ['Qwen2'] }, catalog),
    ).toThrow();
    expect(() => buildAutomationRuleInput({ ...values, kind: 'training' }, catalog)).toThrow();
  });
  it('Runtime非対応のTargetと別ProjectのDatasetを拒否する', () => {
    expect(() =>
      buildAutomationRuleInput(values, {
        ...catalog,
        targets: [{ ...computeTarget, runtimeKinds: ['python'] }],
      }),
    ).toThrow();
    expect(() =>
      buildAutomationRuleInput({ ...values, inputDatasetVersionIds: ['foreign-dataset'] }, catalog),
    ).toThrow();
  });
  it('最大試行回数がAPIの上限を超えると拒否する', () => {
    expect(() => buildAutomationRuleInput({ ...values, maxAttempts: '101' }, catalog)).toThrow();
  });
  it('Targetやコード版を変えると古いGPU選択を残さない', () => {
    expect(
      updateAutomationValues({
        previous: values,
        next: { ...values, targetId: 'another-target' },
        catalog,
      }).gpuIds,
    ).toEqual([]);
    expect(
      updateAutomationValues({
        previous: values,
        next: { ...values, modelFamilies: ['Qwen2'] },
        catalog,
      }),
    ).toMatchObject({ codeVersionId: '', targetId: '', gpuIds: [] });
  });
  it.each(['viewer', 'editor'] as const)('%sは閲覧だけでglobal adminなら変更できる', (role) => {
    expect(canManageAutomationRules(role, false)).toBe(false);
    expect(canManageAutomationRules(role, true)).toBe(true);
  });
  it('Project adminはglobal adminでなくてもルールを変更できる', () => {
    expect(canManageAutomationRules('admin', false)).toBe(true);
  });
});
