import { describe, expect, it } from 'vitest';
import { DomainError } from '../errors.js';
import { createSeededRandom } from '../seededRandom.js';
import type { ParameterAnalysisRun } from './parameterMatrix.js';
import {
  computeParameterImportance,
  IMPORTANCE_MIN_RUNS,
  MAX_IMPORTANCE_PARAMETERS,
  MAX_IMPORTANCE_RUNS,
} from './parameterImportance.js';

/** y = 3a + ノイズ。b は y と無関係。MLflow 経路を真似て a は文字列で渡す。 */
function linearRuns(runCount: number, seed = 1): ParameterAnalysisRun[] {
  const random = createSeededRandom(seed);
  return Array.from({ length: runCount }, () => {
    const a = random.next();
    const b = random.next();
    return { parameters: { a: String(a), b }, metrics: { loss: 3 * a + 0.1 * random.nextGaussian() } };
  });
}

function entryOf(result: ReturnType<typeof computeParameterImportance>, param: string) {
  const entry = result.entries.find((candidate) => candidate.param === param);
  if (!entry) throw new Error(`${param} が結果にありません`);
  return entry;
}

describe('computeParameterImportance', () => {
  it('y=3a+ノイズ では a の importance と correlation が、ノイズの b より大きい', () => {
    const result = computeParameterImportance({ runs: linearRuns(200), objectiveMetric: 'loss' });
    const a = entryOf(result, 'a');
    const b = entryOf(result, 'b');
    expect(a.kind).toBe('numeric');
    expect(a.importance!).toBeGreaterThan(b.importance!);
    expect(a.permutationImportance!).toBeGreaterThan(b.permutationImportance!);
    expect(a.correlation!).toBeGreaterThan(0.9);
    expect(Math.abs(b.correlation!)).toBeLessThan(a.correlation!);
    expect(result.entries[0]!.param).toBe('a');
    expect(result.runCount).toBe(200);
    expect(result.importanceUnavailableReason).toBeNull();
  });

  it('optimizer（adam/sgd）が効くデータでは、カテゴリ列が上位に来る', () => {
    const random = createSeededRandom(9);
    const runs = Array.from({ length: 200 }, () => {
      const optimizer = random.next() < 0.5 ? 'adam' : 'sgd';
      return {
        parameters: { optimizer, batch: String(Math.floor(random.next() * 4) * 32), seedValue: random.next() },
        metrics: { accuracy: (optimizer === 'adam' ? 0.9 : 0.6) + 0.02 * random.nextGaussian() },
      };
    });
    const result = computeParameterImportance({ runs, objectiveMetric: 'accuracy' });
    expect(result.entries[0]).toMatchObject({ param: 'optimizer', kind: 'categorical' });
    expect(result.entries[0]!.importance!).toBeGreaterThan(0.5);
    expect(Math.abs(result.entries[0]!.correlation!)).toBeGreaterThan(0.9);
  });

  it('欠損のある parameter は coverage が下がり、欠損そのものが効けば重要度が付く', () => {
    const random = createSeededRandom(4);
    const runs = Array.from({ length: 100 }, (_, index) => {
      const hasWarmup = index % 4 !== 0;
      return {
        parameters: { ...(hasWarmup ? { warmup: String(random.next()) } : {}), noise: random.next() },
        metrics: { loss: (hasWarmup ? 0 : 2) + 0.05 * random.nextGaussian() },
      };
    });
    const result = computeParameterImportance({ runs, objectiveMetric: 'loss' });
    const warmup = entryOf(result, 'warmup');
    expect(warmup.coverage).toBe(0.75);
    expect(warmup.importance!).toBeGreaterThan(entryOf(result, 'noise').importance!);
  });

  it('全 Run で同じ値の parameter は相関が null で、重要度は0になる', () => {
    const runs = linearRuns(50).map((run) => ({ ...run, parameters: { ...run.parameters, epochs: '10' } }));
    const epochs = entryOf(computeParameterImportance({ runs, objectiveMetric: 'loss' }), 'epochs');
    expect(epochs.correlation).toBeNull();
    expect(epochs.importance).toBe(0);
  });

  it(`Run が ${IMPORTANCE_MIN_RUNS} 件未満なら importance を null にして理由を返す`, () => {
    const result = computeParameterImportance({ runs: linearRuns(4), objectiveMetric: 'loss' });
    expect(result.importanceUnavailableReason).toBe('too_few_runs');
    expect(result.outOfBagR2).toBeNull();
    for (const entry of result.entries) {
      expect(entry.importance).toBeNull();
      expect(entry.permutationImportance).toBeNull();
    }
    expect(entryOf(result, 'a').correlation).not.toBeNull();
  });

  it('目的メトリクスの無い Run は数えず、除外数として返す', () => {
    const runs = [...linearRuns(4), { parameters: { a: '1', b: 1 }, metrics: { accuracy: 1 } }];
    const result = computeParameterImportance({ runs, objectiveMetric: 'loss' });
    expect(result.runCount).toBe(4);
    expect(result.skippedRunCount).toBe(1);
    expect(result.importanceUnavailableReason).toBe('too_few_runs');
  });

  it('parameterNames を渡すとその parameter だけを対象にする', () => {
    const result = computeParameterImportance({ runs: linearRuns(30), objectiveMetric: 'loss', parameterNames: ['b'] });
    expect(result.entries.map((entry) => entry.param)).toEqual(['b']);
  });

  it('同じ seed なら同じ結果を返す', () => {
    const runs = linearRuns(100);
    expect(computeParameterImportance({ runs, objectiveMetric: 'loss', seed: 5 })).toEqual(
      computeParameterImportance({ runs, objectiveMetric: 'loss', seed: 5 }),
    );
    expect(computeParameterImportance({ runs, objectiveMetric: 'loss' })).toEqual(
      computeParameterImportance({ runs, objectiveMetric: 'loss' }),
    );
  });

  it('Run 数か parameter 数が上限を超えると 422 で拒否する', () => {
    const tooManyRuns = Array.from({ length: MAX_IMPORTANCE_RUNS + 1 }, () => ({ parameters: {}, metrics: { loss: 1 } }));
    expect(() => computeParameterImportance({ runs: tooManyRuns, objectiveMetric: 'loss' })).toThrow(
      expect.objectContaining({ status: 422, code: 'too_many_runs' }) as DomainError,
    );
    const wideRun = {
      parameters: Object.fromEntries(Array.from({ length: MAX_IMPORTANCE_PARAMETERS + 1 }, (_, index) => [`p${index}`, index])),
      metrics: { loss: 1 },
    };
    expect(() => computeParameterImportance({ runs: [wideRun], objectiveMetric: 'loss' })).toThrow(
      expect.objectContaining({ status: 422, code: 'too_many_parameters' }) as DomainError,
    );
  });

  it(`${MAX_IMPORTANCE_RUNS} Run × ${MAX_IMPORTANCE_PARAMETERS} parameter を3秒以内に計算する`, () => {
    const random = createSeededRandom(2);
    const runs = Array.from({ length: MAX_IMPORTANCE_RUNS }, () => {
      const parameters: Record<string, number | string> = {};
      for (let index = 0; index < MAX_IMPORTANCE_PARAMETERS; index += 1) {
        // 1割はカテゴリ列にして、one-hot で列が増える場合も含める。
        parameters[`p${index}`] = index % 10 === 0 ? `level-${Math.floor(random.next() * 8)}` : String(random.next());
      }
      return { parameters, metrics: { loss: Number(parameters.p1) + random.next() } };
    });
    const startedAt = performance.now();
    const result = computeParameterImportance({ runs, objectiveMetric: 'loss' });
    const elapsedMs = performance.now() - startedAt;
    expect(result.entries).toHaveLength(MAX_IMPORTANCE_PARAMETERS);
    expect(result.entries[0]!.param).toBe('p1');
    expect(elapsedMs).toBeLessThan(3000);
  });
});
