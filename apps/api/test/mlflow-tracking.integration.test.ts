import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Experiment, Job, LineageGraph, Run, WorkerJob } from '@mmt/contracts';
import { createHarness, entity, request, testDatabaseUrl, type Harness } from './harness.js';
import { executionFixture, projectFixture } from './fixtures.js';
import { modelFixture } from './mlflow-models-fixtures.js';
import { mlflowSdkPythonPath } from './mlflow-sdk-fixtures.js';
import { trackingClient, trackingTestApp, type WireRun } from './mlflow-tracking-fixtures.js';

const metric = { key: 'score', value: 0.9, timestamp: 1700000000000, step: 1 };
const dataset = {
  name: 'training-data',
  digest: 'abc123',
  source_type: 'http',
  source: '{"uri":"http://127.0.0.1:1/do-not-fetch"}',
  schema: '{"columns":["x"]}',
  profile: '{"rows":3}',
};

describe.skipIf(!testDatabaseUrl)('公式MLflow 3 tracking契約（隔離PostgreSQL）', () => {
  let harness: Harness;
  let fixture: Awaited<ReturnType<typeof projectFixture>>;
  let client: ReturnType<typeof trackingClient>;
  let app: ReturnType<typeof trackingTestApp>;
  beforeAll(async () => {
    harness = await createHarness();
    app = trackingTestApp(harness);
  });
  beforeEach(async () => {
    await harness.reset();
    fixture = await projectFixture(harness);
    client = trackingClient(app, fixture);
  });
  afterAll(async () => {
    await harness?.close();
  });

  it('RunのないExperimentを登録・取得・改名し、同名retryを正しいcodeで拒否する', async () => {
    const missing = await client.get('/experiments/get-by-name', {
      experiment_name: 'SDK experiment',
    });
    expect(missing.status).toBe(404);
    const created = await entity<{ experiment_id: string }>(
      await client.post('/experiments/create', {
        name: 'SDK experiment',
        tags: [{ key: 'purpose', value: 'test' }],
      }),
      200,
    );
    const experiment = await entity<{
      experiment: { experiment_id: string; name: string; tags: unknown[] };
    }>(await client.get('/experiments/get', created), 200);
    expect(experiment.experiment.tags).toEqual([{ key: 'purpose', value: 'test' }]);
    expect((await client.post('/experiments/create', { name: 'SDK experiment' })).status).toBe(409);
    expect(
      await (await client.post('/experiments/create', { name: 'SDK experiment' })).json(),
    ).toMatchObject({ code: 'resource_already_exists' });
    expect(
      (await client.post('/experiments/update', { ...created, new_name: 'renamed' })).status,
    ).toBe(200);
    expect(
      (
        await client.post('/experiments/set-experiment-tag', {
          ...created,
          key: 'purpose',
          value: 'renamed',
        })
      ).status,
    ).toBe(200);
    expect(
      (await client.post('/experiments/delete-experiment-tag', { ...created, key: 'purpose' }))
        .status,
    ).toBe(200);
    const listed = await entity<{ items: Experiment[] }>(
      await request(harness.app, `${fixture.basePath}/experiments`, {
        cookie: fixture.viewer.cookie,
      }),
      200,
    );
    expect(listed.items.find((item) => item.id === created.experiment_id)).toMatchObject({
      name: 'renamed',
      runCount: 0,
    });
  });

  it('Experiment検索でtags・属性・paginationを扱い、違う検索のtokenを拒否する', async () => {
    for (const name of ['batch-c', 'batch-a', 'batch-b'])
      await entity(
        await client.post('/experiments/create', {
          name,
          tags: [{ key: 'team', value: 'research' }],
        }),
        200,
      );
    const query = {
      filter: "name LIKE 'batch-%' AND tags.team = 'research'",
      order_by: ['name ASC'],
      max_results: '2',
    };
    const first = await entity<{ experiments: { name: string }[]; next_page_token: string }>(
      await client.post('/experiments/search', query),
      200,
    );
    expect(first.experiments.map((experiment) => experiment.name)).toEqual(['batch-a', 'batch-b']);
    const second = await entity<{ experiments: { name: string }[]; next_page_token?: string }>(
      await client.post('/experiments/search', { ...query, page_token: first.next_page_token }),
      200,
    );
    expect(second.experiments.map((experiment) => experiment.name)).toEqual(['batch-c']);
    expect(second.next_page_token).toBeUndefined();
    expect(
      (
        await client.post('/experiments/search', {
          ...query,
          filter: "name = 'other'",
          page_token: first.next_page_token,
        })
      ).status,
    ).toBe(400);
  });

  it('既定ExperimentへRunを作り、native Runの状態・名称・親Runも同期する', async () => {
    const defaultRun = await client.createRun({
      experiment_id: '0',
      start_time: '1700000000000',
      run_name: 'default',
    });
    expect(defaultRun.info.experiment_id).not.toBe('0');
    const parent = await client.createRun({ run_name: 'parent' });
    const child = await client.createRun({
      tags: [
        { key: 'mlflow.parentRunId', value: parent.info.run_id },
        { key: 'mlflow.runName', value: 'child' },
      ],
    });
    expect(child.info.status).toBe('RUNNING');
    expect(
      (
        await client.post('/runs/set-tag', {
          run_id: child.info.run_id,
          key: 'mlflow.runName',
          value: 'renamed-child',
        })
      ).status,
    ).toBe(200);
    const native = await entity<Run>(
      await request(harness.app, `${fixture.basePath}/runs/${child.info.run_id}`, {
        cookie: fixture.viewer.cookie,
      }),
      200,
    );
    expect(native).toMatchObject({
      name: 'renamed-child',
      parentRunId: parent.info.run_id,
      status: 'running',
    });
    for (const invalidParent of ['', 'not-a-uuid']) {
      expect(
        (
          await client.post('/runs/set-tag', {
            run_id: child.info.run_id,
            key: 'mlflow.parentRunId',
            value: invalidParent,
          })
        ).status,
      ).toBe(422);
    }
    expect((await client.getRun(child.info.run_id)).data.tags).toContainEqual({
      key: 'mlflow.parentRunId',
      value: parent.info.run_id,
    });
    const runCount = (await harness.database.query('SELECT count(*) FROM runs')).rows[0].count;
    expect(
      (
        await client.post('/runs/create', {
          experiment_id: fixture.experiment.id,
          tags: [{ key: 'mlflow.parentRunId', value: '' }],
        })
      ).status,
    ).toBe(422);
    expect((await harness.database.query('SELECT count(*) FROM runs')).rows[0].count).toBe(
      runCount,
    );
    expect(
      (
        await client.post('/runs/set-tag', {
          run_id: parent.info.run_id,
          key: 'mlflow.parentRunId',
          value: child.info.run_id,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await client.post('/runs/delete-tag', {
          run_id: child.info.run_id,
          key: 'mlflow.parentRunId',
        })
      ).status,
    ).toBe(200);
    expect(
      (await client.getRun(child.info.run_id)).data.tags.some(
        (tag) => tag.key === 'mlflow.parentRunId',
      ),
    ).toBe(false);
  });

  it('Run終了とresumeで同じ版・parametersを保持し、終了時刻をクリアする', async () => {
    const run = await client.createRun({ start_time: metric.timestamp });
    await entity(
      await client.post('/runs/log-parameter', {
        run_id: run.info.run_id,
        key: 'lr',
        value: '0.01',
      }),
      200,
    );
    const ended = await entity<{ run_info: WireRun['info'] }>(
      await client.post('/runs/update', {
        run_id: run.info.run_id,
        status: 'FINISHED',
        end_time: metric.timestamp + 20,
      }),
      200,
    );
    expect(ended.run_info).toMatchObject({ status: 'FINISHED', end_time: metric.timestamp + 20 });
    const resumed = await entity<{ run_info: WireRun['info'] }>(
      await client.post('/runs/update', { run_id: run.info.run_id, status: 'RUNNING' }),
      200,
    );
    expect(resumed.run_info).toMatchObject({
      run_id: run.info.run_id,
      status: 'RUNNING',
      start_time: metric.timestamp,
    });
    expect(resumed.run_info.end_time).toBeUndefined();
    expect((await client.getRun(run.info.run_id)).data.params).toEqual([
      { key: 'lr', value: '0.01' },
    ]);
  });

  it('native APIからもSDK Runのparam不変性を守り、Run名とmlflow.runNameを同期する', async () => {
    const run = await client.createRun();
    await entity(
      await client.post('/runs/log-parameter', {
        run_id: run.info.run_id,
        key: 'epochs',
        value: '3',
      }),
      200,
    );
    const endpoint = `${fixture.basePath}/runs/${run.info.run_id}`;
    expect(
      (
        await request(harness.app, endpoint, {
          method: 'PATCH',
          cookie: fixture.editor.cookie,
          body: { parameters: { epochs: '4' } },
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await request(harness.app, endpoint, {
          method: 'PATCH',
          cookie: fixture.editor.cookie,
          body: { parameters: { new: 4 } },
        })
      ).status,
    ).toBe(409);
    await entity(
      await request(harness.app, endpoint, {
        method: 'PATCH',
        cookie: fixture.editor.cookie,
        body: { name: 'native-name', parameters: { epochs: '3' } },
      }),
      200,
    );
    const saved = await client.getRun(run.info.run_id);
    expect(saved.info.run_name).toBe('native-name');
    expect(saved.data.tags).toContainEqual({ key: 'mlflow.runName', value: 'native-name' });
    expect(
      (await client.post('/runs/delete-tag', { run_id: run.info.run_id, key: 'missing-tag' }))
        .status,
    ).toBe(404);
  });

  it('paramsはstringで不変、同値retryは成功し、失敗batchはmetricsとtagsを残さない', async () => {
    const run = await client.createRun();
    const batch = {
      run_id: run.info.run_id,
      params: [{ key: 'lr', value: '0.01' }],
      metrics: [metric],
      tags: [{ key: 'phase', value: 'initial' }],
    };
    await entity(await client.post('/runs/log-batch', batch), 200);
    await entity(await client.post('/runs/log-batch', batch), 200);
    expect(
      (await client.post('/runs/log-parameter', { run_id: run.info.run_id, key: 'bad', value: 3 }))
        .status,
    ).toBe(422);
    const failed = await client.post('/runs/log-batch', {
      ...batch,
      params: [{ key: 'lr', value: '0.02' }],
      metrics: [{ ...metric, step: 2 }],
      tags: [{ key: 'phase', value: 'failed' }],
    });
    expect(failed.status).toBe(400);
    const saved = await client.getRun(run.info.run_id);
    expect(saved.data.params).toEqual([{ key: 'lr', value: '0.01' }]);
    expect(saved.data.tags).toContainEqual({ key: 'phase', value: 'initial' });
    const history = await entity<{ metrics: unknown[] }>(
      await client.get('/metrics/get-history', { run_id: run.info.run_id, metric_key: 'score' }),
      200,
    );
    expect(history.metrics).toHaveLength(1);
  });

  it('同時log-batchの競合では一方のparamだけを保存し、そのbatch全体をatomicに反映する', async () => {
    const run = await client.createRun();
    const responses = await Promise.all(
      ['left', 'right'].map((value, step) =>
        client.post('/runs/log-batch', {
          run_id: run.info.run_id,
          params: [{ key: 'branch', value }],
          tags: [{ key: 'winner', value }],
          metrics: [{ ...metric, step }],
        }),
      ),
    );
    expect(responses.map((response) => response.status).sort()).toEqual([200, 400]);
    const saved = await client.getRun(run.info.run_id);
    expect(saved.data.tags).toContainEqual({ key: 'winner', value: saved.data.params[0]!.value });
    expect(
      (await harness.database.query('SELECT * FROM metrics WHERE run_id=$1', [run.info.run_id]))
        .rows,
    ).toHaveLength(1);
  });

  it('同時に親Runを相互に指定しても一方を拒否し、循環lineageを保存しない', async () => {
    const first = await client.createRun();
    const second = await client.createRun();
    const responses = await Promise.all([
      client.post('/runs/set-tag', {
        run_id: first.info.run_id,
        key: 'mlflow.parentRunId',
        value: second.info.run_id,
      }),
      client.post('/runs/set-tag', {
        run_id: second.info.run_id,
        key: 'mlflow.parentRunId',
        value: first.info.run_id,
      }),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 400]);
    expect(
      (
        await harness.database.query(
          'SELECT parent_run_id FROM runs WHERE parent_run_id IS NOT NULL',
        )
      ).rows,
    ).toHaveLength(1);
  });

  it('metricsのretry重複を防ぎ、最新値をstep・timestamp・valueの順に決定する', async () => {
    const run = await client.createRun();
    const points = [
      metric,
      { ...metric, step: 3, value: 3 },
      { ...metric, step: 1, timestamp: metric.timestamp + 1000, value: 1 },
      { ...metric, step: 3, timestamp: metric.timestamp + 10, value: 4 },
      { ...metric, step: 3, timestamp: metric.timestamp + 10, value: 2 },
    ];
    for (const point of points)
      await entity(
        await client.post('/runs/log-metric', { run_id: run.info.run_id, ...point }),
        200,
      );
    await Promise.all(
      Array.from({ length: 3 }, () =>
        client.post('/runs/log-metric', { run_id: run.info.run_id, ...points[3] }),
      ),
    );
    expect((await client.getRun(run.info.run_id)).data.metrics).toEqual([{ ...points[3] }]);
    const native = await entity<Run>(
      await request(harness.app, `${fixture.basePath}/runs/${run.info.run_id}`, {
        cookie: fixture.viewer.cookie,
      }),
      200,
    );
    expect(native.latestMetrics).toEqual({ score: 4 });
    const first = await entity<{ metrics: unknown[]; next_page_token: string }>(
      await client.get('/metrics/get-history', {
        run_id: run.info.run_id,
        metric_key: 'score',
        max_results: '3',
      }),
      200,
    );
    const second = await entity<{ metrics: unknown[] }>(
      await client.get('/metrics/get-history', {
        run_id: run.info.run_id,
        metric_key: 'score',
        max_results: '3',
        page_token: first.next_page_token,
      }),
      200,
    );
    expect(first.metrics.length + second.metrics.length).toBe(5);
  });

  it('SDKのNaN/Infinityと負stepを保存し、時刻・整数・run_uuidの不正入力を拒否する', async () => {
    const run = await client.createRun();
    for (const value of ['NaN', 'Infinity', '-Infinity'])
      await entity(
        await client.post('/runs/log-metric', {
          run_id: run.info.run_id,
          key: value,
          value,
          timestamp: String(metric.timestamp),
          step: '-1',
        }),
        200,
      );
    expect(
      (await client.getRun(run.info.run_id)).data.metrics.map((point) => point.value).sort(),
    ).toEqual(['-Infinity', 'Infinity', 'NaN']);
    for (const changed of [
      { timestamp: -1 },
      { step: 1.3 },
      { value: true },
      { run_uuid: randomUUID() },
    ])
      expect(
        (await client.post('/runs/log-metric', { run_id: run.info.run_id, ...metric, ...changed }))
          .status,
      ).toBe(422);
  });

  it('int64 stepと1msのtimestampを丸めず保存し、範囲外stepを明示エラーにする', async () => {
    const run = await client.createRun();
    const point = { ...metric, step: '9223372036854775807', timestamp: metric.timestamp + 1 };
    await entity(await client.post('/runs/log-metric', { run_id: run.info.run_id, ...point }), 200);
    await entity(await client.post('/runs/log-metric', { run_id: run.info.run_id, ...point }), 200);
    expect((await client.getRun(run.info.run_id)).data.metrics).toEqual([point]);
    const history = await entity<{ metrics: unknown[] }>(
      await client.get('/metrics/get-history', { run_id: run.info.run_id, metric_key: point.key }),
      200,
    );
    expect(history.metrics).toEqual([point]);
    for (const step of ['9223372036854775808', '-9223372036854775809', 'invalid'])
      expect(
        (await client.post('/runs/log-metric', { run_id: run.info.run_id, ...metric, step }))
          .status,
      ).toBe(422);
  });

  it('Run検索のparams/tags/metrics/attributesと欠落値の並べ替え・paginationが正しく動く', async () => {
    const ids: string[] = [];
    for (const [name, score] of [
      ['alpha', 2],
      ['beta', 3],
      ['missing', null],
    ] as const) {
      const run = await client.createRun({ run_name: name });
      ids.push(run.info.run_id);
      await entity(
        await client.post('/runs/log-batch', {
          run_id: run.info.run_id,
          params: [{ key: 'model variant', value: 'Qwen' }],
          tags: [{ key: 'team', value: 'research' }],
          metrics: score === null ? [] : [{ ...metric, value: score }],
        }),
        200,
      );
    }
    const query = {
      experiment_ids: [fixture.experiment.id],
      filter:
        "params.`model variant` = 'Qwen' AND tags.team ILIKE 'RE%' AND attributes.status = 'RUNNING'",
      order_by: ['metrics.score DESC'],
      max_results: 2,
    };
    const first = await entity<{ runs: WireRun[]; next_page_token: string }>(
      await client.post('/runs/search', query),
      200,
    );
    expect(first.runs.map((run) => run.info.run_name)).toEqual(['beta', 'alpha']);
    const second = await entity<{ runs: WireRun[]; next_page_token?: string }>(
      await client.post('/runs/search', { ...query, page_token: first.next_page_token }),
      200,
    );
    expect(second.runs.map((run) => run.info.run_name)).toEqual(['missing']);
    const filtered = await entity<{ runs: WireRun[] }>(
      await client.post('/runs/search', {
        experiment_ids: [fixture.experiment.id],
        filter: `metrics.score >= 3 AND attributes.run_id IN ('${ids[0]}','${ids[1]}')`,
      }),
      200,
    );
    expect(filtered.runs.map((run) => run.info.run_name)).toEqual(['beta']);
    expect(
      (await client.post('/runs/search', { ...query, filter: 'tags.none IS NULL' })).status,
    ).toBe(200);
  });

  it('未対応・SQL注入syntaxを拒否し、引用符付きの値はSQLパラメータとして扱う', async () => {
    const run = await client.createRun();
    await entity(
      await client.post('/runs/set-tag', {
        run_id: run.info.run_id,
        key: 'quote',
        value: "O'Reilly; DROP TABLE runs;",
      }),
      200,
    );
    const valid = await entity<{ runs: WireRun[] }>(
      await client.post('/runs/search', {
        experiment_ids: [fixture.experiment.id],
        filter: "tags.quote = 'O''Reilly; DROP TABLE runs;'",
      }),
      200,
    );
    expect(valid.runs).toHaveLength(1);
    for (const filter of [
      "tags.a = 'b' OR tags.a = 'c'",
      'metrics.score = 1; DROP TABLE runs',
      "attributes.unknown = 'x'",
      "attributes.constructor = 'x'",
      "attributes.__proto__ = 'x'",
      "tags.a RLIKE 'x'",
      "metrics.score = 'abc'",
    ])
      expect(
        (await client.post('/runs/search', { experiment_ids: [fixture.experiment.id], filter }))
          .status,
      ).toBe(400);
    expect(
      (
        await client.post('/runs/search', {
          experiment_ids: [fixture.experiment.id],
          order_by: ['metrics.score DESC; DROP TABLE runs'],
        })
      ).status,
    ).toBe(400);
    expect((await harness.database.query('SELECT count(*) FROM runs')).rows[0].count).toBe('1');
  });

  it('__proto__というparam/tag名も文字列データとして保存・検索できる', async () => {
    const run = await client.createRun();
    await entity(
      await client.post('/runs/log-batch', {
        run_id: run.info.run_id,
        params: [{ key: '__proto__', value: 'parameter' }],
        tags: [{ key: '__proto__', value: 'tag' }],
      }),
      200,
    );
    const saved = await client.getRun(run.info.run_id);
    expect(saved.data.params).toEqual([{ key: '__proto__', value: 'parameter' }]);
    expect(saved.data.tags).toContainEqual({ key: '__proto__', value: 'tag' });
    const searched = await entity<{ runs: WireRun[] }>(
      await client.post('/runs/search', {
        experiment_ids: [fixture.experiment.id],
        filter: "params.__proto__ = 'parameter' AND tags.__proto__ = 'tag'",
      }),
      200,
    );
    expect(searched.runs).toHaveLength(1);
    await entity(
      await client.post('/experiments/set-experiment-tag', {
        experiment_id: fixture.experiment.id,
        key: '__proto__',
        value: 'experiment',
      }),
      200,
    );
    const experiment = await entity<{ experiment: { tags: unknown[] } }>(
      await client.get('/experiments/get', { experiment_id: fixture.experiment.id }),
      200,
    );
    expect(experiment.experiment.tags).toContainEqual({ key: '__proto__', value: 'experiment' });
  });

  it('同時log-batch中のget/searchはtagsと最新metricsを同じ保存時点から返す', async () => {
    const run = await client.createRun();
    const logGeneration = (generation: number) =>
      client.post('/runs/log-batch', {
        run_id: run.info.run_id,
        tags: [{ key: 'generation', value: String(generation) }],
        metrics: [{ ...metric, value: generation, step: generation }],
      });
    await entity(await logGeneration(0), 200);
    const writer = async () => {
      for (let generation = 1; generation <= 8; generation++)
        await entity(await logGeneration(generation), 200);
    };
    const reader = async () => {
      for (let attempt = 0; attempt < 8; attempt++) {
        const saved =
          attempt % 2
            ? await client.getRun(run.info.run_id)
            : (
                await entity<{ runs: WireRun[] }>(
                  await client.post('/runs/search', { experiment_ids: [fixture.experiment.id] }),
                  200,
                )
              ).runs[0]!;
        expect(saved.data.metrics[0]!.value).toBe(
          Number(saved.data.tags.find((tag) => tag.key === 'generation')!.value),
        );
      }
    };
    await Promise.all([writer(), reader()]);
  });

  it('Run/Experimentのsoftdelete・restoreはnative listとRun書込みにも反映する', async () => {
    const run = await client.createRun();
    await entity(await client.post('/runs/delete', { run_id: run.info.run_id }), 200);
    expect((await client.getRun(run.info.run_id)).info.lifecycle_stage).toBe('deleted');
    expect(
      (await client.post('/runs/log-metric', { run_id: run.info.run_id, ...metric })).status,
    ).toBe(400);
    expect(
      (
        await entity<{ items: Run[] }>(
          await request(harness.app, `${fixture.basePath}/runs`, { cookie: fixture.viewer.cookie }),
          200,
        )
      ).items,
    ).toEqual([]);
    await entity(await client.post('/runs/restore', { run_id: run.info.run_id }), 200);
    await entity(
      await client.post('/experiments/delete', { experiment_id: fixture.experiment.id }),
      200,
    );
    expect((await client.getRun(run.info.run_id)).info.lifecycle_stage).toBe('deleted');
    expect(
      (await client.post('/runs/create', { experiment_id: fixture.experiment.id })).status,
    ).toBe(400);
    expect(
      (
        await entity<{ items: Experiment[] }>(
          await request(harness.app, `${fixture.basePath}/experiments`, {
            cookie: fixture.viewer.cookie,
          }),
          200,
        )
      ).items,
    ).toEqual([]);
    const deleted = await entity<{ runs: WireRun[] }>(
      await client.post('/runs/search', {
        experiment_ids: [fixture.experiment.id],
        run_view_type: 'DELETED_ONLY',
      }),
      200,
    );
    expect(deleted.runs).toHaveLength(1);
    await entity(
      await client.post('/experiments/restore', { experiment_id: fixture.experiment.id }),
      200,
    );
    expect((await client.getRun(run.info.run_id)).info.lifecycle_stage).toBe('active');
    expect(
      (
        await entity<{ items: Run[] }>(
          await request(harness.app, `${fixture.basePath}/runs`, { cookie: fixture.viewer.cookie }),
          200,
        )
      ).items,
    ).toHaveLength(1);
  });

  it('Dataset log-inputsはdigest/source/contextを保持しnative版とlineageへ結び、再送を重複させない', async () => {
    const run = await client.createRun();
    const input = {
      run_id: run.info.run_id,
      datasets: [{ dataset, tags: [{ key: 'mlflow.data.context', value: 'training' }] }],
    };
    await entity(await client.post('/runs/log-inputs', input), 200);
    await entity(await client.post('/runs/log-inputs', input), 200);
    const second = await client.createRun();
    await entity(
      await client.post('/runs/log-inputs', { ...input, run_id: second.info.run_id }),
      200,
    );
    expect((await client.getRun(run.info.run_id)).inputs.dataset_inputs).toEqual(input.datasets);
    const native = await entity<Run>(
      await request(harness.app, `${fixture.basePath}/runs/${run.info.run_id}`, {
        cookie: fixture.viewer.cookie,
      }),
      200,
    );
    expect(native.inputDatasetVersionIds).toHaveLength(1);
    const version = (await harness.database.query('SELECT * FROM dataset_versions')).rows[0];
    expect(version).toMatchObject({
      digest: dataset.digest,
      uri: 'http://127.0.0.1:1/do-not-fetch',
      metadata: { mlflow: dataset },
    });
    expect((await harness.database.query('SELECT * FROM dataset_versions')).rows).toHaveLength(1);
    const lineage = await entity<LineageGraph>(
      await request(harness.app, `${fixture.basePath}/lineage`, { cookie: fixture.viewer.cookie }),
      200,
    );
    expect(lineage.edges).toContainEqual({
      source: native.inputDatasetVersionIds[0],
      target: run.info.run_id,
      relation: 'input',
    });
    const searched = await entity<{ runs: WireRun[] }>(
      await client.post('/runs/search', {
        experiment_ids: [fixture.experiment.id],
        filter: "datasets.name = 'training-data' AND datasets.context = 'training'",
      }),
      200,
    );
    expect(searched.runs).toHaveLength(2);
    expect(
      (
        await client.post('/runs/log-inputs', {
          ...input,
          datasets: [{ dataset: { ...dataset, schema: 'conflicting' }, tags: [] }],
        })
      ).status,
    ).toBe(400);
  });

  it('MLflow検索とnative検索は同じdataset・params・属性filterで同じRunを返す', async () => {
    const withDataset = await client.createRun({ run_name: 'with-dataset' });
    await entity(
      await client.post('/runs/log-inputs', {
        run_id: withDataset.info.run_id,
        datasets: [{ dataset, tags: [{ key: 'mlflow.data.context', value: 'training' }] }],
      }),
      200,
    );
    await entity(
      await client.post('/runs/log-parameter', {
        run_id: withDataset.info.run_id,
        key: 'lr',
        value: '0.01',
      }),
      200,
    );
    await client.createRun({ run_name: 'without-dataset' });
    for (const filter of [
      "datasets.name = 'training-data' AND datasets.context = 'training'",
      "datasets.digest NOT IN ('abc123')",
      "params.lr = '0.01' AND attributes.run_name LIKE 'with-%'",
      `attributes.run_id IN ('${withDataset.info.run_id}')`,
    ]) {
      const mlflow = await entity<{ runs?: WireRun[] }>(
        await client.post('/runs/search', { experiment_ids: [fixture.experiment.id], filter }),
        200,
      );
      const native = await entity<{ items: Run[] }>(
        await request(harness.app, `${fixture.basePath}/runs/search`, {
          method: 'POST',
          cookie: fixture.viewer.cookie,
          body: { experimentIds: [fixture.experiment.id], filter },
        }),
        200,
      );
      expect(native.items.map((run) => run.id).sort()).toEqual(
        (mlflow.runs ?? []).map((run) => run.info.run_id).sort(),
      );
    }
  });

  it('Dataset入力batchは途中の保存失敗でもnative版・Run参照を残さない', async () => {
    const run = await client.createRun();
    await harness.database.query(
      "CREATE FUNCTION reject_dataset_version() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture storage failure'; END $$",
    );
    await harness.database.query(
      'CREATE TRIGGER reject_mlflow_dataset BEFORE INSERT ON dataset_versions FOR EACH ROW EXECUTE FUNCTION reject_dataset_version()',
    );
    try {
      await expect(
        client.post('/runs/log-inputs', {
          run_id: run.info.run_id,
          datasets: [{ dataset, tags: [] }],
        }),
      ).rejects.toThrow('fixture storage failure');
      expect((await harness.database.query('SELECT * FROM mlflow_datasets')).rows).toEqual([]);
      expect((await harness.database.query('SELECT * FROM datasets')).rows).toEqual([]);
      expect((await client.getRun(run.info.run_id)).inputs.dataset_inputs).toEqual([]);
    } finally {
      await harness.database.query('DROP TRIGGER reject_mlflow_dataset ON dataset_versions');
      await harness.database.query('DROP FUNCTION reject_dataset_version()');
    }
  });

  it('runs:write tokenは新しいRegistry版を作れず、登録済みDatasetの入力追加はできる', async () => {
    const run = await client.createRun();
    const minted = await entity<{ token: string }>(
      await request(harness.app, '/api/tokens', {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: {
          name: 'tracking-only',
          kind: 'personal',
          projectId: fixture.project.id,
          scopes: ['runs:write'],
        },
      }),
    );
    const input = { run_id: run.info.run_id, datasets: [{ dataset, tags: [] }] };
    const endpoint = `${client.base}/runs/log-inputs`;
    expect(
      (await request(app, endpoint, { method: 'POST', token: minted.token, body: input })).status,
    ).toBe(403);
    expect((await harness.database.query('SELECT * FROM dataset_versions')).rows).toEqual([]);
    await entity(await client.post('/runs/log-inputs', input), 200);
    const second = await client.createRun();
    await entity(
      await request(app, endpoint, {
        method: 'POST',
        token: minted.token,
        body: { ...input, run_id: second.info.run_id },
      }),
      200,
    );
    expect((await client.getRun(second.info.run_id)).inputs.dataset_inputs).toEqual(input.datasets);
  });

  it('metrics保存に失敗したlog-batchはparamsとtagsもrollbackする', async () => {
    const run = await client.createRun();
    await harness.database.query(
      "CREATE FUNCTION reject_metric_point() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture metric failure'; END $$",
    );
    await harness.database.query(
      'CREATE TRIGGER reject_mlflow_metric BEFORE INSERT ON metrics FOR EACH ROW EXECUTE FUNCTION reject_metric_point()',
    );
    try {
      await expect(
        client.post('/runs/log-batch', {
          run_id: run.info.run_id,
          metrics: [metric],
          params: [{ key: 'atomic', value: 'yes' }],
          tags: [{ key: 'atomic', value: 'yes' }],
        }),
      ).rejects.toThrow('fixture metric failure');
      const saved = await client.getRun(run.info.run_id);
      expect(saved.data.params).toEqual([]);
      expect(saved.data.tags.some((tag) => tag.key === 'atomic')).toBe(false);
      expect(saved.data.metrics).toEqual([]);
    } finally {
      await harness.database.query('DROP TRIGGER reject_mlflow_metric ON metrics');
      await harness.database.query('DROP FUNCTION reject_metric_point()');
    }
  });

  it('モデル入力・出力・文脈付きmetricを保持し、別Project・矛盾するpointと出力をatomicに拒否する', async () => {
    const run = await client.createRun();
    const modelId = `m-${randomUUID().replaceAll('-', '')}`;
    await harness.database.query(
      'INSERT INTO mlflow_logged_models(id,project_id,experiment_id,source_run_id,name,created_by) VALUES($1,$2,$3,$4,$5,$6)',
      [
        modelId,
        fixture.project.id,
        fixture.experiment.id,
        run.info.run_id,
        'test-model',
        fixture.editor.userId,
      ],
    );
    const point = {
      ...metric,
      model_id: modelId,
      dataset_name: dataset.name,
      dataset_digest: dataset.digest,
    };
    await entity(
      await client.post('/runs/log-inputs', {
        run_id: run.info.run_id,
        models: [{ model_id: modelId }],
      }),
      200,
    );
    await entity(
      await client.post('/runs/outputs', {
        run_id: run.info.run_id,
        models: [{ model_id: modelId, step: '2' }],
      }),
      200,
    );
    await entity(
      await client.post('/runs/log-batch', { run_id: run.info.run_id, metrics: [point] }),
      200,
    );
    await entity(
      await client.post('/runs/log-batch', { run_id: run.info.run_id, metrics: [point] }),
      200,
    );
    const saved = await client.getRun(run.info.run_id);
    expect(saved.inputs.model_inputs).toEqual([{ model_id: modelId }]);
    expect(saved.outputs.model_outputs).toEqual([{ model_id: modelId, step: 2 }]);
    expect(saved.data.metrics).toEqual([point]);
    const modelMetrics = (await harness.database.query('SELECT * FROM mlflow_logged_model_metrics'))
      .rows;
    expect(modelMetrics).toHaveLength(1);
    expect(modelMetrics[0]).toMatchObject({
      model_id: modelId,
      run_id: run.info.run_id,
      key: metric.key,
      timestamp_ms: String(metric.timestamp),
      dataset_name: dataset.name,
      dataset_digest: dataset.digest,
    });
    const failed = await client.post('/runs/log-batch', {
      run_id: run.info.run_id,
      metrics: [{ ...point, value: 2 }],
      params: [{ key: 'atomic', value: 'no' }],
      tags: [{ key: 'atomic', value: 'no' }],
    });
    expect(failed.status).toBe(409);
    expect((await client.getRun(run.info.run_id)).data.params).toEqual([]);
    const secondRun = await client.createRun();
    expect(
      (
        await client.post('/runs/outputs', {
          run_id: secondRun.info.run_id,
          models: [{ model_id: modelId }],
        })
      ).status,
    ).toBe(400);
    const other = await projectFixture(harness);
    const otherClient = trackingClient(app, other);
    const otherRun = await otherClient.createRun();
    expect(
      (
        await otherClient.post('/runs/log-inputs', {
          run_id: otherRun.info.run_id,
          datasets: [{ dataset, tags: [] }],
          models: [{ model_id: modelId }],
        })
      ).status,
    ).toBe(400);
    expect(
      (await otherClient.post('/runs/log-metric', { run_id: otherRun.info.run_id, ...point }))
        .status,
    ).toBe(400);
    expect((await otherClient.getRun(otherRun.info.run_id)).inputs.dataset_inputs).toEqual([]);
  });

  it('同じRunのモデル出力・Artifact転送・Registry登録を並行しても全件を保存する', async () => {
    const models = await modelFixture(harness);
    const pending = (await models.createLogged()).model.info.model_id;
    const ready = (await models.readyModel({ name: 'registry-source' })).model.info.model_id;
    await entity(await models.createRegistered(), 200);
    // Enough overlapping requests to contend for the Run and both model rows.
    const parallelWrites = 6;
    const responses = await Promise.all(
      Array.from({ length: parallelWrites }, (_, step) => [
        models.upload(pending, `concurrent-${step}.bin`, `artifact-${step}`),
        request(models.app, `${models.base}/api/2.0/mlflow/runs/outputs`, {
          method: 'POST',
          cookie: models.editor.cookie,
          body: {
            run_id: models.run.id,
            models: [
              { model_id: pending, step },
              { model_id: ready, step },
            ],
          },
        }),
        models.register(ready),
      ]).flat(),
    );
    expect(responses.map((response) => response.status)).toEqual(
      Array(parallelWrites * 3).fill(200),
    );
    expect(
      (
        await harness.database.query('SELECT * FROM mlflow_run_model_outputs WHERE run_id=$1', [
          models.run.id,
        ])
      ).rows,
    ).toHaveLength(parallelWrites * 2);
    expect(
      (
        await harness.database.query('SELECT * FROM mlflow_artifact_paths WHERE owner_id=$1', [
          pending,
        ])
      ).rows,
    ).toHaveLength(parallelWrites);
    expect(
      (
        await harness.database.query('SELECT * FROM model_versions WHERE project_id=$1', [
          models.project.id,
        ])
      ).rows,
    ).toHaveLength(parallelWrites);
  });

  it('Job管理RunへのSDK start/endは成功し、worker resumeでも状態・時刻・実行paramsを保持する', async () => {
    const execution = await executionFixture(harness);
    const managedClient = trackingClient(app, execution);
    const run = await execution.newRun();
    const launchParameters = { epochs: 3, deterministic: true, disabled: false, seed: null };
    await entity(
      await request(harness.app, `${execution.basePath}/runs/${run.id}`, {
        method: 'PATCH',
        cookie: execution.editor.cookie,
        body: { parameters: launchParameters },
      }),
      200,
    );
    const job = await entity<Job>(
      await request(harness.app, `${execution.basePath}/jobs`, {
        method: 'POST',
        cookie: execution.editor.cookie,
        body: { runId: run.id, targetId: execution.target.id, gpuIds: ['0'] },
      }),
    );
    const claimed = await entity<{ item: WorkerJob }>(
      await request(harness.app, '/api/worker/claim', {
        method: 'POST',
        token: execution.workerToken,
        body: { workerId: 'mlflow-worker' },
      }),
      200,
    );
    const before = (
      await harness.database.query('SELECT status,started_at,ended_at FROM runs WHERE id=$1', [
        run.id,
      ])
    ).rows[0];
    for (const status of ['RUNNING', 'FINISHED', 'FAILED', 'KILLED']) {
      const updated = await entity<{ run_info: WireRun['info'] }>(
        await managedClient.post('/runs/update', {
          run_id: run.id,
          status,
          end_time: metric.timestamp,
        }),
        200,
      );
      expect(updated.run_info.status).toBe('RUNNING');
    }
    expect(
      (
        await harness.database.query('SELECT status,started_at,ended_at FROM runs WHERE id=$1', [
          run.id,
        ])
      ).rows[0],
    ).toEqual(before);
    const recordedParameters = {
      epochs: '3',
      deterministic: 'True',
      disabled: 'False',
      seed: 'None',
      'logged-extra': 'yes',
    };
    const params = Object.entries(recordedParameters).map(([key, value]) => ({ key, value }));
    await entity(
      await managedClient.post('/runs/log-batch', { run_id: run.id, params, metrics: [metric] }),
      200,
    );
    await entity(
      await managedClient.post('/runs/log-batch', { run_id: run.id, params, metrics: [metric] }),
      200,
    );
    const savedJob = (await harness.database.query('SELECT status FROM jobs WHERE id=$1', [job.id]))
      .rows[0];
    expect(savedJob.status).toBe(claimed.item.job.status);
    const executionParameters = (
      await harness.database.query('SELECT parameters,recorded_parameters FROM runs WHERE id=$1', [
        run.id,
      ])
    ).rows[0];
    expect(executionParameters.parameters).toEqual(launchParameters);
    expect(executionParameters.recorded_parameters).toEqual(recordedParameters);
    const native = await entity<Run & { recordedParameters: unknown }>(
      await request(harness.app, `${execution.basePath}/runs/${run.id}`, {
        cookie: execution.viewer.cookie,
      }),
      200,
    );
    expect(native.parameters).toEqual(launchParameters);
    expect(native.recordedParameters).toEqual(recordedParameters);
    const resumed = await entity<{ items: WorkerJob[] }>(
      await request(harness.app, '/api/worker/resume', {
        method: 'POST',
        token: execution.workerToken,
        body: { workerId: 'mlflow-worker' },
      }),
      200,
    );
    expect(resumed.items[0]!.run.parameters).toEqual(launchParameters);
    expect(
      Object.fromEntries(
        (await managedClient.getRun(run.id)).data.params.map(({ key, value }) => [key, value]),
      ),
    ).toEqual(recordedParameters);
    expect(
      (
        await managedClient.post('/runs/log-parameter', {
          run_id: run.id,
          key: 'epochs',
          value: '4',
        })
      ).status,
    ).toBe(400);
    expect((await managedClient.post('/runs/delete', { run_id: run.id })).status).toBe(409);
  });

  it('viewer/outsider/別Project参照・read専用tokenは書込みできない', async () => {
    const run = await client.createRun();
    expect(
      (
        await client.post(
          '/runs/log-metric',
          { run_id: run.info.run_id, ...metric },
          fixture.viewer.cookie,
        )
      ).status,
    ).toBe(403);
    expect(
      (await client.get('/runs/get', { run_id: run.info.run_id }, fixture.outsider.cookie)).status,
    ).toBe(403);
    const other = await projectFixture(harness);
    const otherRun = await trackingClient(app, other).createRun();
    expect((await client.get('/runs/get', { run_id: otherRun.info.run_id })).status).toBe(404);
    expect((await client.post('/runs/create', { experiment_id: other.experiment.id })).status).toBe(
      404,
    );
    expect(
      (
        await client.post('/runs/set-tag', {
          run_id: run.info.run_id,
          key: 'mlflow.parentRunId',
          value: otherRun.info.run_id,
        })
      ).status,
    ).toBe(404);
    const minted = await entity<{ token: string }>(
      await request(harness.app, '/api/tokens', {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: {
          name: 'read only',
          kind: 'personal',
          projectId: fixture.project.id,
          scopes: ['read'],
        },
      }),
    );
    expect(
      (
        await request(app, `${client.base}/runs/get?run_id=${run.info.run_id}`, {
          token: minted.token,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await request(app, `${client.base}/runs/log-metric`, {
          method: 'POST',
          token: minted.token,
          body: { run_id: run.info.run_id, ...metric },
        })
      ).status,
    ).toBe(403);
    expect((await request(app, `${client.base}/runs/get?run_id=${run.info.run_id}`)).status).toBe(
      401,
    );
    expect(
      (
        await request(
          app,
          `/api/mlflow/projects/${other.project.id}/api/2.0/mlflow/runs/get?run_id=${otherRun.info.run_id}`,
          { token: minted.token },
        )
      ).status,
    ).toBe(403);
  });

  it('legacy log-modelはRun履歴を記録し、指定Artifact保存先など未対応操作を成功扱いにしない', async () => {
    const run = await client.createRun();
    const model = {
      run_id: run.info.run_id,
      artifact_path: 'legacy-model',
      flavors: { python_function: {} },
    };
    for (let retry = 0; retry < 2; retry++)
      await entity(
        await client.post('/runs/log-model', {
          run_id: run.info.run_id,
          model_json: JSON.stringify(model),
        }),
        200,
      );
    const tags = (await client.getRun(run.info.run_id)).data.tags;
    expect(JSON.parse(tags.find((tag) => tag.key === 'mlflow.log-model.history')!.value)).toEqual([
      model,
    ]);
    expect(
      (
        await client.post('/experiments/create', {
          name: 'unsupported',
          artifact_location: 's3://unconfigured/path',
        })
      ).status,
    ).toBe(422);
    expect(
      (await client.post('/runs/log-model', { run_id: run.info.run_id, model_json: 'broken' }))
        .status,
    ).toBe(400);
  });

  it.skipIf(!existsSync(mlflowSdkPythonPath))(
    '実SDKのprotobufとEntityはExperiment・Run・metrics・Datasetをそのまま読める',
    async () => {
      const run = await client.createRun();
      await entity(
        await client.post('/runs/log-batch', {
          run_id: run.info.run_id,
          metrics: [metric],
          params: [{ key: 'epochs', value: '2' }],
        }),
        200,
      );
      await entity(
        await client.post('/runs/log-inputs', {
          run_id: run.info.run_id,
          datasets: [{ dataset, tags: [] }],
        }),
        200,
      );
      const experiment = await entity(
        await client.get('/experiments/get', { experiment_id: fixture.experiment.id }),
        200,
      );
      const history = await entity(
        await client.get('/metrics/get-history', { run_id: run.info.run_id, metric_key: 'score' }),
        200,
      );
      const envelopes = JSON.stringify({
        run: { run: await client.getRun(run.info.run_id) },
        experiment,
        history,
      });
      const script =
        'import json,sys\nfrom google.protobuf.json_format import ParseDict\nfrom mlflow.protos import service_pb2 as s\nfrom mlflow.entities import Run,Experiment,Metric\nenvelopes=json.loads(sys.argv[1])\nrun=Run.from_proto(ParseDict(envelopes["run"],s.GetRun.Response()).run)\nexperiment=Experiment.from_proto(ParseDict(envelopes["experiment"],s.GetExperiment.Response()).experiment)\nhistory=ParseDict(envelopes["history"],s.GetMetricHistory.Response())\nassert run.info.run_id and run.data.params["epochs"]=="2"\nassert run.inputs.dataset_inputs[0].dataset.digest=="abc123"\nassert run.info.experiment_id==experiment.experiment_id\nassert Metric.from_proto(history.metrics[0]).timestamp==1700000000000\nprint("SDK response decode passed")';
      const decoded = await promisify(execFile)(mlflowSdkPythonPath, ['-c', script, envelopes], {
        env: { ...process.env, MLFLOW_DISABLE_AGENT_HINT: '1' },
      });
      expect(decoded.stdout.trim()).toBe('SDK response decode passed');
    },
  );
});
