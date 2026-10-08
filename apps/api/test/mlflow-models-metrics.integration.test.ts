import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Run } from '@mmt/contracts';
import type { SearchLoggedModels } from '../src/mlflow/models/validation.js';
import { createHarness, entity, request, testDatabaseUrl, type Harness } from './harness.js';
import { modelFixture, type ModelFixture } from './mlflow-models-fixtures.js';

interface ModelMetricPoint {
  key?: string;
  value: number | 'NaN';
  timestamp: number;
  step: number;
  dataset_name?: string;
  dataset_digest?: string;
}

interface LoggedModelMetricsResponse {
  model: {
    info: { model_id: string };
    data: {
      metrics: {
        key: string;
        value: number | string;
        timestamp: string;
        step: string;
        model_id: string;
        run_id: string;
        dataset_name?: string;
        dataset_digest?: string;
      }[];
    };
  };
}

interface ModelSearchResponse {
  models: LoggedModelMetricsResponse['model'][];
  next_page_token?: string;
}

describe.skipIf(!testDatabaseUrl)('Logged Model metricsの履歴・filter・order', () => {
  let harness: Harness;
  let fixture: ModelFixture;
  beforeAll(async () => {
    harness = await createHarness();
  });
  beforeEach(async () => {
    await harness.reset();
    fixture = await modelFixture(harness);
  });
  afterAll(async () => {
    await harness?.close();
  });

  async function logPoints(input: {
    modelId: string;
    points: ModelMetricPoint[];
    runId?: string;
  }): Promise<void> {
    await entity(
      await request(fixture.app, `${fixture.base}/api/2.0/mlflow/runs/log-batch`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: {
          run_id: input.runId ?? fixture.run.id,
          metrics: input.points.map((point) => ({
            ...point,
            key: point.key ?? 'accuracy',
            timestamp: String(point.timestamp),
            step: String(point.step),
            model_id: input.modelId,
          })),
        },
      }),
      200,
    );
  }

  async function search(input: Partial<Omit<SearchLoggedModels, 'experiment_ids'>> = {}) {
    return entity<ModelSearchResponse>(
      await request(fixture.app, `${fixture.modelEndpoint}/search`, {
        method: 'POST',
        cookie: fixture.viewer.cookie,
        body: { experiment_ids: [fixture.experiment.id], ...input },
      }),
      200,
    );
  }

  function modelIds(response: ModelSearchResponse): string[] {
    return response.models.map((model) => model.info.model_id);
  }

  it('getとsearchが異なるstep・timestampの全点を返し、同じpointの再送は増えない', async () => {
    const created = await fixture.createLogged();
    const id = created.model.info.model_id;
    const points = [
      { value: 0.9, step: 0, timestamp: 1000 },
      { value: 0.4, step: 1, timestamp: 2000 },
    ];
    await logPoints({ modelId: id, points });
    await logPoints({ modelId: id, points: [points[0]!] });
    const loaded = await entity<LoggedModelMetricsResponse>(
      await request(fixture.app, `${fixture.modelEndpoint}/${id}`, {
        cookie: fixture.viewer.cookie,
      }),
      200,
    );
    const expected = points.map((point) => ({
      key: 'accuracy',
      value: point.value,
      timestamp: String(point.timestamp),
      step: String(point.step),
      model_id: id,
      run_id: fixture.run.id,
    }));
    expect(loaded.model.data.metrics).toEqual(expected);
    expect((await search()).models[0]?.data.metrics).toEqual(expected);
  });

  it('過去の一致点を最新の不一致点で隠さず、各比較をdatasetとdigest内の保存点で判定する', async () => {
    const created = await fixture.createLogged();
    const id = created.model.info.model_id;
    await logPoints({
      modelId: id,
      points: [
        { value: 0.9, step: 0, timestamp: 1000, dataset_name: 'validation', dataset_digest: 'v1' },
        { value: 0.4, step: 1, timestamp: 2000, dataset_name: 'validation', dataset_digest: 'v1' },
        { value: 0.3, step: 2, timestamp: 3000, dataset_name: 'validation', dataset_digest: 'v2' },
        { value: 0.2, step: 3, timestamp: 4000, dataset_name: 'training', dataset_digest: 't1' },
      ],
    });
    const filter = 'metrics.accuracy >= 0.8';
    expect(modelIds(await search({ filter }))).toEqual([id]);
    const validation = [{ dataset_name: 'validation', dataset_digest: 'v1' }];
    const scoped = await search({ filter, datasets: validation });
    expect(modelIds(scoped)).toEqual([id]);
    // Dataset search limits matching models, while each returned model still exposes its history.
    expect(scoped.models[0]?.data.metrics).toHaveLength(4);
    expect(
      modelIds(
        await search({
          filter: 'metrics.accuracy >= 0.8 AND metrics.accuracy <= 0.5',
          datasets: validation,
        }),
      ),
    ).toEqual([id]);
    expect(
      modelIds(
        await search({
          filter,
          datasets: [{ dataset_name: 'validation', dataset_digest: 'v2' }],
        }),
      ),
    ).toEqual([]);
    expect(
      modelIds(
        await search({
          filter,
          datasets: [{ dataset_name: 'training' }, ...validation],
        }),
      ),
    ).toEqual([id]);
    expect(modelIds(await search({ datasets: validation }))).toEqual([id]);
    expect(
      modelIds(
        await search({ datasets: [{ dataset_name: 'validation', dataset_digest: 'missing' }] }),
      ),
    ).toEqual([]);
  });

  it('同じモデルに複数の一致点があっても検索pageで重複せず全モデルへ進める', async () => {
    const expectedIds: string[] = [];
    for (const name of ['A', 'B', 'C']) {
      const created = await fixture.createLogged({ name });
      const id = created.model.info.model_id;
      expectedIds.push(id);
      await logPoints({
        modelId: id,
        points: [
          { value: 0.9, timestamp: 1000, step: 0 },
          { value: 0.95, timestamp: 2000, step: 1 },
        ],
      });
    }
    let pageToken: string | undefined;
    const foundIds: string[] = [];
    for (const index of expectedIds.keys()) {
      const page = await search({
        filter: 'metrics.accuracy > 0.8',
        order_by: [{ field_name: 'name', ascending: true }],
        max_results: 1,
        ...(pageToken ? { page_token: pageToken } : {}),
      });
      expect(page.models).toHaveLength(1);
      expect(page.models[0]?.data.metrics).toHaveLength(2);
      foundIds.push(...modelIds(page));
      pageToken = page.next_page_token;
      if (index < expectedIds.length - 1) expect(pageToken).toBeDefined();
      else expect(pageToken).toBeUndefined();
    }
    expect(foundIds).toEqual(expectedIds);
  });

  it('orderの代表点をtimestamp降順→step降順→run ID昇順で選ぶ', async () => {
    const ids: string[] = [];
    for (const name of ['A past', 'B middle', 'C step', 'D run'])
      ids.push((await fixture.createLogged({ name })).model.info.model_id);
    await logPoints({
      modelId: ids[0]!,
      points: [
        { value: 0.9, timestamp: 1000, step: 100 },
        { value: 0.1, timestamp: 2000, step: 0 },
      ],
    });
    await logPoints({ modelId: ids[1]!, points: [{ value: 0.5, timestamp: 2000, step: 0 }] });
    await logPoints({
      modelId: ids[2]!,
      points: [
        { value: 0.7, timestamp: 2000, step: 1 },
        { value: 0.2, timestamp: 2000, step: 0 },
      ],
    });
    const otherRun = await entity<Run>(
      await request(harness.app, `${fixture.basePath}/runs`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: { experimentId: fixture.experiment.id, name: 'Other evaluation', kind: 'evaluation' },
      }),
    );
    const [lowerRunId, higherRunId] = [fixture.run.id, otherRun.id].sort();
    await logPoints({
      modelId: ids[3]!,
      runId: lowerRunId!,
      points: [{ value: 0.8, timestamp: 2000, step: 2 }],
    });
    await logPoints({
      modelId: ids[3]!,
      runId: higherRunId!,
      points: [{ value: 0.05, timestamp: 2000, step: 2 }],
    });
    expect(
      modelIds(await search({ order_by: [{ field_name: 'metrics.accuracy', ascending: false }] })),
    ).toEqual([...ids].reverse());
    expect(
      modelIds(await search({ order_by: [{ field_name: 'metrics.accuracy', ascending: true }] })),
    ).toEqual(ids);
  });

  it('orderのdataset scopeだけで代表点を絞り、検索datasetsとは混ぜない', async () => {
    const first = (await fixture.createLogged({ name: 'A' })).model.info.model_id;
    const second = (await fixture.createLogged({ name: 'B' })).model.info.model_id;
    await logPoints({
      modelId: first,
      points: [
        { value: 0.8, timestamp: 1000, step: 0, dataset_name: 'validation', dataset_digest: 'v1' },
        { value: 0.2, timestamp: 2000, step: 1, dataset_name: 'validation', dataset_digest: 'v2' },
        { value: 0.1, timestamp: 3000, step: 2, dataset_name: 'training', dataset_digest: 't1' },
      ],
    });
    await logPoints({
      modelId: second,
      points: [
        { value: 0.5, timestamp: 2000, step: 0, dataset_name: 'validation', dataset_digest: 'v1' },
      ],
    });
    const datasets = [{ dataset_name: 'validation', dataset_digest: 'v1' }];
    expect(
      modelIds(
        await search({
          datasets,
          order_by: [{ field_name: 'metrics.accuracy', ascending: false }],
        }),
      ),
    ).toEqual([second, first]);
    expect(
      modelIds(
        await search({
          order_by: [
            { field_name: 'metrics.accuracy', ascending: false, dataset_name: 'validation' },
          ],
        }),
      ),
    ).toEqual([second, first]);
    expect(
      modelIds(
        await search({
          order_by: [
            {
              field_name: 'metrics.accuracy',
              ascending: false,
              dataset_name: 'validation',
              dataset_digest: 'v1',
            },
          ],
        }),
      ),
    ).toEqual([first, second]);
  });

  it('保存済みNaNを!=だけに一致させ、ASC/DESCとも通常値→NaN→欠損に並べる', async () => {
    const values = { negative: -1, zero: 0, positive: 1, nan: 'NaN', missing: undefined } as const;
    const ids: Record<string, string> = {};
    for (const [name, value] of Object.entries(values)) {
      const id = (await fixture.createLogged({ name })).model.info.model_id;
      ids[name] = id;
      if (value !== undefined)
        await logPoints({
          modelId: id,
          points: [{ key: 'loss', value, timestamp: 1000, step: 0 }],
        });
    }
    const comparisons: { filter: string; names: string[] }[] = [
      { filter: 'metrics.loss > 0', names: ['positive'] },
      { filter: 'metrics.loss >= 0', names: ['positive', 'zero'] },
      { filter: 'metrics.loss < 0', names: ['negative'] },
      { filter: 'metrics.loss <= 0', names: ['negative', 'zero'] },
      { filter: 'metrics.loss = 0', names: ['zero'] },
      { filter: 'metrics.loss != 0', names: ['nan', 'negative', 'positive'] },
    ];
    for (const comparison of comparisons)
      expect(
        modelIds(
          await search({
            filter: comparison.filter,
            order_by: [{ field_name: 'name', ascending: true }],
          }),
        ),
      ).toEqual(comparison.names.map((name) => ids[name]));
    for (const ascending of [true, false]) {
      const ordered = await search({ order_by: [{ field_name: 'metrics.loss', ascending }] });
      const names = ascending
        ? ['negative', 'zero', 'positive', 'nan', 'missing']
        : ['positive', 'zero', 'negative', 'nan', 'missing'];
      expect(modelIds(ordered)).toEqual(names.map((name) => ids[name]));
      const nan = ordered.models.find((model) => model.info.model_id === ids.nan);
      expect(nan?.data.metrics[0]?.value).toBe('NaN');
      const missing = ordered.models.find((model) => model.info.model_id === ids.missing);
      expect(missing?.data.metrics).toEqual([]);
    }
  });
});
