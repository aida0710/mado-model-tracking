import { describe, expect, it } from 'vitest';
import { convertWandbSweepConfig } from './sweepConfig';
import { applySearchSettings, buildSweepCreate, formSearchSettings, initialSweepForm, type SweepFormValues } from './sweepForm';

function form(change: Partial<SweepFormValues>): SweepFormValues {
  let id = 0;
  return { ...initialSweepForm('task', () => `row-${id++}`), name: 'lr-search', metric: 'val_loss', ...change };
}

describe('Sweep作成フォームからAPIの入力を作る', () => {
  it('gridの2×2・並列2をTaskの既定のtargetで送る形にする', () => {
    const result = buildSweepCreate(form({
      method: 'grid',
      maxTrials: '4',
      parallelism: '2',
      rows: [
        { ...initialSweepForm('task', () => 'a').rows[0]!, id: 'a', name: 'lr', values: '0.1, 0.01' },
        { ...initialSweepForm('task', () => 'b').rows[0]!, id: 'b', name: 'batch_size', values: '8, 16' },
      ],
    }));
    expect(result.fieldErrors).toEqual({});
    expect(result.input).toEqual({
      name: 'lr-search',
      taskId: 'task',
      method: 'grid',
      searchSpace: { lr: { values: [0.1, 0.01] }, batch_size: { values: [8, 16] } },
      objective: { metric: 'val_loss', goal: 'minimize', aggregation: 'last' },
      maxTrials: 4,
      parallelism: 2,
      earlyStopping: null,
      targetId: null,
      gpuIds: null,
    });
  });

  it('seed・target・GPU・hyperbandを指定した値で送る', () => {
    const base = form({});
    const { input } = buildSweepCreate({
      ...base,
      rows: [{ ...base.rows[0]!, name: 'lr', values: '1' }],
      seed: '0',
      targetId: 'target',
      gpuIds: '0, 1',
      earlyStopping: 'hyperband',
      minIter: '2',
      eta: '3',
      maxIter: '18',
    });
    expect(input).toMatchObject({
      seed: 0,
      targetId: 'target',
      gpuIds: ['0', '1'],
      earlyStopping: { type: 'hyperband', minIter: 2, eta: 3, maxIter: 18 },
    });
  });

  it('名前・目的メトリクス・整数の誤り、空の探索空間は送らずに項目のエラーにする', () => {
    const result = buildSweepCreate(form({ name: ' ', metric: '', maxTrials: '0', parallelism: '1.5', seed: '-1', rows: [] }));
    expect(result.input).toBeNull();
    expect(Object.keys(result.fieldErrors).sort()).toEqual(['maxTrials', 'metric', 'name', 'parallelism', 'seed']);
    expect(result.searchSpaceError).not.toBeNull();
  });

  it('W&B形式から読み込んだ設定をフォームに入れ、名前とTaskは残す', () => {
    const settings = convertWandbSweepConfig({
      method: 'bayes',
      metric: { name: 'accuracy', goal: 'maximize' },
      parameters: { lr: { distribution: 'log_uniform_values', min: 0.001, max: 0.1 } },
      early_terminate: { type: 'hyperband', min_iter: 1 },
      run_cap: 12,
    });
    let id = 0;
    const loaded = applySearchSettings(form({}), settings, () => `loaded-${id++}`);
    expect(loaded).toMatchObject({ name: 'lr-search', taskId: 'task', method: 'bayes', metric: 'accuracy', goal: 'maximize', maxTrials: '12', earlyStopping: 'hyperband', eta: '3' });
    expect(buildSweepCreate(loaded).input?.searchSpace).toEqual({ lr: { distribution: 'log_uniform', min: 0.001, max: 0.1 } });
    expect(formSearchSettings(loaded)).toMatchObject({ method: 'bayes', maxTrials: 12, earlyStopping: { minIter: 1, eta: 3 } });
  });
});
