import { Hono } from 'hono';
import type { PoolClient } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DomainError } from '../src/domain/errors.js';
import type { Database } from '../src/db/database.js';
import { authentication } from '../src/http/authMiddleware.js';
import type { ApiEnvironment } from '../src/http/request.js';
import { mlflowTrackingRoutes } from '../src/mlflow/tracking/index.js';
import { mlflowArtifactRoutes } from '../src/mlflow/artifacts/index.js';
import { ArtifactService } from '../src/services/artifactService.js';
import { projectFixture } from './fixtures.js';
import { createHarness, entity, request, testDatabaseUrl, type Harness } from './harness.js';
import { trackingClient, trackingTestApp, type WireRun } from './mlflow-tracking-fixtures.js';

function createSignal() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function boundMember(target: object, property: PropertyKey): unknown {
  const member = Reflect.get(target, property, target);
  return typeof member === 'function' ? member.bind(target) : member;
}

function pauseConnectionQuery(
  connection: PoolClient,
  beforeQuery: (sql: string) => Promise<void>,
): PoolClient {
  return new Proxy(connection, {
    get(client, property) {
      if (property !== 'query') return boundMember(client, property);
      return async (sql: string, parameters?: unknown[]) => {
        await beforeQuery(sql);
        return client.query(sql, parameters);
      };
    },
  });
}

function pauseLockQuery(database: Database, plan: { pattern: RegExp; occurrence: number }) {
  const entered = createSignal();
  const released = createSignal();
  let matches = 0;
  const beforeQuery = async (sql: string) => {
    if (!plan.pattern.test(sql) || ++matches !== plan.occurrence) return;
    entered.resolve();
    await released.promise;
  };
  // Control the conflicting HTTP operations without replacing PostgreSQL's real locks.
  const pausedDatabase = new Proxy(database, {
    get(pool, property) {
      if (property !== 'connect') return boundMember(pool, property);
      return async () => pauseConnectionQuery(await pool.connect(), beforeQuery);
    },
  });
  return { database: pausedDatabase, entered: entered.promise, release: released.resolve };
}

describe.skipIf(!testDatabaseUrl)('MLflow tracking reviewの回帰検証（隔離PostgreSQL）', () => {
  let harness: Harness;
  let fixture: Awaited<ReturnType<typeof projectFixture>>;
  let client: ReturnType<typeof trackingClient>;

  beforeAll(async () => {
    harness = await createHarness();
  });
  beforeEach(async () => {
    await harness.reset();
    fixture = await projectFixture(harness);
    client = trackingClient(trackingTestApp(harness), fixture);
  });
  afterAll(async () => {
    await harness?.close();
  });

  it('画面とSDKから同名Experimentを同時作成しても一つだけ登録する', async () => {
    const name = 'Shared experiment name';
    const responses = await Promise.all(
      Array.from({ length: 4 }, () => [
        request(harness.app, `${fixture.basePath}/experiments`, {
          method: 'POST',
          cookie: fixture.editor.cookie,
          body: { name },
        }),
        client.post('/experiments/create', { name }),
      ]).flat(),
    );
    expect(responses.filter((response) => response.ok)).toHaveLength(1);
    expect(responses.filter((response) => !response.ok).map((response) => response.status)).toEqual(
      Array(7).fill(409),
    );
    const registered = await harness.database.query(
      'SELECT id FROM experiments WHERE project_id=$1 AND name=$2',
      [fixture.project.id, name],
    );
    expect(registered.rows).toHaveLength(1);
  });

  it.each([
    { owner: 'run', phase: '初期認可', occurrence: 1 },
    { owner: 'run', phase: '保存transaction', occurrence: 2 },
    { owner: 'model', phase: '初期認可', occurrence: 1 },
    { owner: 'model', phase: '保存transaction', occurrence: 2 },
  ] as const)(
    '$owner Artifact PUTの$phaseとExperiment改名が交差しても両方保存できる',
    async (scenario) => {
      const run = await client.createRun();
      let ownerId = run.info.run_id;
      if (scenario.owner === 'model') {
        const model = await harness.database.query<{ id: string }>(
          `INSERT INTO mlflow_logged_models(id,project_id,experiment_id,source_run_id,name,created_by)
         VALUES('m-'||replace(gen_random_uuid()::text,'-',''),$1,$2,$3,'Rename source',$4) RETURNING id`,
          [fixture.project.id, fixture.experiment.id, run.info.run_id, fixture.editor.userId],
        );
        ownerId = model.rows[0]!.id;
      }
      const renameBarrier = pauseLockQuery(harness.database, {
        pattern: /\bFROM\s+projects\b[\s\S]*\bFOR\s+UPDATE\b/i,
        occurrence: 1,
      });
      const uploadBarrier = pauseLockQuery(harness.database, {
        pattern: /\bFROM\s+experiments\b[\s\S]*\bFOR\s+SHARE\b/i,
        occurrence: scenario.occurrence,
      });
      const app = new Hono<ApiEnvironment>();
      app.onError((error, context) => {
        if (error instanceof DomainError)
          return context.json({ message: error.message, code: error.code }, error.status);
        throw error;
      });
      app.use('*', authentication(harness.services.auth));
      app.route(
        '/api/mlflow/projects/:p',
        mlflowTrackingRoutes({
          database: renameBarrier.database,
          runs: harness.services.runs,
          registry: harness.services.registry,
          runCompletion: harness.services.runCompletion,
        }),
      );
      app.route(
        '/api/mlflow/projects/:p',
        mlflowArtifactRoutes({
          database: uploadBarrier.database,
          artifacts: new ArtifactService(uploadBarrier.database, harness.stores),
        }),
      );
      const artifactUrl = `/api/mlflow/projects/${fixture.project.id}/api/2.0/mlflow-artifacts/artifacts/${scenario.owner}s/${ownerId}/artifacts/rename.bin`;
      const contents = `saved while renaming ${scenario.owner} ${scenario.phase}`;
      const upload = request(app, artifactUrl, {
        method: 'PUT',
        cookie: fixture.editor.cookie,
        binary: contents,
      });
      let rename: Promise<Response> | undefined;
      try {
        // PUT has Project SHARE but has not requested Experiment SHARE yet.
        await uploadBarrier.entered;
        rename = trackingClient(app, fixture).post('/experiments/update', {
          experiment_id: fixture.experiment.id,
          new_name: 'renamed during PUT',
        });
        await renameBarrier.entered;
        // The old rename held Experiment UPDATE here, creating the reported cycle.
        renameBarrier.release();
        uploadBarrier.release();
        const outcomes = await Promise.allSettled([rename, upload]);
        for (const outcome of outcomes) {
          expect(outcome.status).toBe('fulfilled');
          if (outcome.status === 'fulfilled') expect(outcome.value.status).toBe(200);
        }
      } finally {
        renameBarrier.release();
        uploadBarrier.release();
        await Promise.allSettled([upload, ...(rename ? [rename] : [])]);
      }
      const experiment = await entity<{ experiment: { name: string } }>(
        await client.get('/experiments/get', { experiment_id: fixture.experiment.id }),
        200,
      );
      expect(experiment.experiment.name).toBe('renamed during PUT');
      const downloaded = await request(app, artifactUrl, { cookie: fixture.viewer.cookie });
      expect(downloaded.status).toBe(200);
      expect(await downloaded.text()).toBe(contents);
    },
  );

  async function createMetricRuns() {
    const values = {
      negative: -2,
      zero: 0,
      positive: 2,
      nan: 'NaN',
      positiveInfinity: 'Infinity',
      negativeInfinity: '-Infinity',
      missing: null,
    } as const;
    for (const [name, value] of Object.entries(values)) {
      const run = await client.createRun({ run_name: name });
      if (value !== null)
        await entity(
          await client.post('/runs/log-metric', {
            run_id: run.info.run_id,
            key: 'loss',
            value,
            step: 0,
            timestamp: 1700000000000,
          }),
          200,
        );
    }
  }

  it('NaN metricは!=だけに一致し、未記録をどの数値filterにも含めない', async () => {
    await createMetricRuns();
    const comparisons = [
      ['> 0', ['positive', 'positiveInfinity']],
      ['>= 0', ['zero', 'positive', 'positiveInfinity']],
      ['< 0', ['negative', 'negativeInfinity']],
      ['<= 0', ['negative', 'negativeInfinity', 'zero']],
      ['= 0', ['zero']],
      ['!= 0', ['negative', 'negativeInfinity', 'positive', 'positiveInfinity', 'nan']],
    ] as const;
    for (const [comparison, names] of comparisons) {
      const page = await entity<{ runs: WireRun[] }>(
        await client.post('/runs/search', {
          experiment_ids: [fixture.experiment.id],
          filter: `metrics.loss ${comparison}`,
        }),
        200,
      );
      expect(page.runs.map((run) => run.info.run_name).sort()).toEqual([...names].sort());
    }
  });

  it('metric昇順・降順とも数値→NaN→未記録で並び、paginationでも順位を保つ', async () => {
    await createMetricRuns();
    const directions = [
      [
        'ASC',
        ['negativeInfinity', 'negative', 'zero', 'positive', 'positiveInfinity', 'nan', 'missing'],
      ],
      [
        'DESC',
        ['positiveInfinity', 'positive', 'zero', 'negative', 'negativeInfinity', 'nan', 'missing'],
      ],
    ] as const;
    for (const [direction, names] of directions) {
      const found: WireRun[] = [];
      let pageToken: string | undefined;
      do {
        const page = await entity<{ runs: WireRun[]; next_page_token?: string }>(
          await client.post('/runs/search', {
            experiment_ids: [fixture.experiment.id],
            order_by: [`metrics.loss ${direction}`],
            max_results: 2,
            ...(pageToken ? { page_token: pageToken } : {}),
          }),
          200,
        );
        found.push(...page.runs);
        pageToken = page.next_page_token;
      } while (pageToken);
      expect(found.map((run) => run.info.run_name)).toEqual(names);
      expect(found.find((run) => run.info.run_name === 'nan')?.data.metrics[0]?.value).toBe('NaN');
      expect(found.find((run) => run.info.run_name === 'missing')?.data.metrics).toEqual([]);
    }
  });
});
