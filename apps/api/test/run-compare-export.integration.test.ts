import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  RUN_EXPORT_TRUNCATED_HEADER,
  type Dataset,
  type DatasetVersion,
  type Model,
  type ModelVersion,
  type Run,
  type RunComparison,
  type RunComparisonRequest,
  type RunSearchRequest,
} from '@mmt/contracts';
import { createApplication } from '../src/app.js';
import { CSV_BYTE_ORDER_MARK } from '../src/domain/csvEncoding.js';
import { createHarness, entity, request, testDatabaseUrl, type Harness } from './harness.js';
import { projectFixture } from './fixtures.js';

type Fixture = Awaited<ReturnType<typeof projectFixture>>;
type Credentials = { cookie?: string; token?: string };

// Larger than one search page (500), so the export reads several pages while streaming.
const MULTI_PAGE_RUN_COUNT = 1200;

// Response.text() drops a leading BOM, so the bytes are decoded with it kept.
const csvDecoder = () => new TextDecoder('utf-8', { ignoreBOM: true });
const responseCsv = async (response: Response) => csvDecoder().decode(await response.arrayBuffer());

/** Splits CSV text without quoted line breaks into lines; enough for these fixtures. */
function csvLines(csv: string): string[] {
  expect(csv.startsWith(CSV_BYTE_ORDER_MARK)).toBe(true);
  const lines = csv.slice(CSV_BYTE_ORDER_MARK.length).split('\r\n');
  expect(lines.pop()).toBe('');
  return lines;
}

describe.skipIf(!testDatabaseUrl)('Runの一括比較とCSV出力（独立PostgreSQL）', () => {
  let harness: Harness;
  let fixture: Fixture;
  beforeAll(async () => {
    harness = await createHarness();
  });
  beforeEach(async () => {
    await harness.reset();
    fixture = await projectFixture(harness);
  });
  afterAll(async () => {
    await harness?.close();
  });

  const compare = (
    body: RunComparisonRequest,
    credentials: Credentials = { cookie: fixture.viewer.cookie },
  ) =>
    request(harness.app, `${fixture.basePath}/runs/compare`, {
      method: 'POST',
      body,
      ...credentials,
    });
  const compareCsv = (
    query: { runIds: string[]; baselineRunId?: string },
    credentials: Credentials = { cookie: fixture.viewer.cookie },
  ) =>
    request(
      harness.app,
      `${fixture.basePath}/runs/compare.csv?${new URLSearchParams({
        runIds: query.runIds.join(','),
        ...(query.baselineRunId ? { baselineRunId: query.baselineRunId } : {}),
      })}`,
      credentials,
    );
  const exportCsv = (
    body: RunSearchRequest,
    options: { credentials?: Credentials; app?: Harness['app'] } = {},
  ) =>
    request(options.app ?? harness.app, `${fixture.basePath}/runs/search/export.csv`, {
      method: 'POST',
      body,
      ...(options.credentials ?? { cookie: fixture.viewer.cookie }),
    });
  async function createRun(body: Record<string, unknown>): Promise<Run> {
    return entity<Run>(
      await request(harness.app, `${fixture.basePath}/runs`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: {
          experimentId: fixture.experiment.id,
          kind: 'training',
          ...body,
        },
      }),
    );
  }
  async function logMetrics(runId: string, metrics: Record<string, number>): Promise<void> {
    const response = await request(harness.app, `${fixture.basePath}/runs/${runId}/metrics`, {
      method: 'POST',
      cookie: fixture.editor.cookie,
      body: {
        metrics: Object.entries(metrics).map(([name, value]) => ({
          name,
          value,
          step: 1,
          timestamp: new Date().toISOString(),
        })),
      },
    });
    expect(response.status).toBe(204);
  }
  async function mintToken(body: { projectId: string; scopes: string[] }): Promise<string> {
    const minted = await entity<{ token: string }>(
      await request(harness.app, '/api/tokens', {
        method: 'POST',
        cookie: fixture.administrator.cookie,
        body: { name: 'Compare export test', kind: 'personal', ...body },
      }),
    );
    return minted.token;
  }
  async function createOtherProjectRun(): Promise<Run> {
    const otherProject = await entity<{ id: string }>(
      await request(harness.app, '/api/projects', {
        method: 'POST',
        cookie: fixture.administrator.cookie,
        body: { name: 'Other Project' },
      }),
    );
    const otherExperiment = await entity<{ id: string }>(
      await request(harness.app, `/api/projects/${otherProject.id}/experiments`, {
        method: 'POST',
        cookie: fixture.administrator.cookie,
        body: { name: 'Other Experiment' },
      }),
    );
    return entity<Run>(
      await request(harness.app, `/api/projects/${otherProject.id}/runs`, {
        method: 'POST',
        cookie: fixture.administrator.cookie,
        body: {
          experimentId: otherExperiment.id,
          name: 'foreign',
          kind: 'training',
        },
      }),
    );
  }
  async function evaluationReferences() {
    const model = await entity<Model>(
      await request(harness.app, `${fixture.basePath}/models`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: { name: 'Speech Model', family: 'speech' },
      }),
    );
    const modelVersion = await entity<ModelVersion>(
      await request(harness.app, `${fixture.basePath}/models/${model.id}/versions`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: {},
      }),
    );
    const dataset = await entity<Dataset>(
      await request(harness.app, `${fixture.basePath}/datasets`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: { name: 'eval-set', namespace: 'speech' },
      }),
    );
    const datasetVersion = await entity<DatasetVersion>(
      await request(harness.app, `${fixture.basePath}/datasets/${dataset.id}/versions`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: { version: 'v2', uri: 'file:///eval', digest: 'eval-v2' },
      }),
    );
    return { modelVersion, datasetVersion };
  }

  it('runIdsの順を保ち、基準Runとの差分と評価DatasetVersion・ModelVersionを返す', async () => {
    const { modelVersion, datasetVersion } = await evaluationReferences();
    const evaluation = {
      kind: 'evaluation',
      modelVersionId: modelVersion.id,
      inputDatasetVersionIds: [datasetVersion.id],
    };
    const baseline = await createRun({
      name: 'baseline',
      parameters: { lr: 0.1 },
      ...evaluation,
    });
    const candidate = await createRun({
      name: 'candidate',
      parameters: { lr: 0.01, layers: [1, 2] },
      tags: { team: 'asr' },
      ...evaluation,
    });
    const unlogged = await createRun({ name: 'unlogged' });
    await logMetrics(baseline.id, { wer: 0.2, cer: 0.1 });
    await logMetrics(candidate.id, { wer: 0.15 });
    // A later step leaves wer NaN as the latest value of this Run.
    await harness.database.query(
      `UPDATE runs SET latest_metrics=latest_metrics || jsonb_build_object('wer','NaN'::float8) WHERE id=$1`,
      [unlogged.id],
    );

    const runIds = [candidate.id, unlogged.id, baseline.id];
    const comparison = await entity<RunComparison>(
      await compare({ runIds, baselineRunId: baseline.id }),
      200,
    );
    expect(comparison.runs.map((run) => run.id)).toEqual(runIds);
    expect(comparison.baselineRunId).toBe(baseline.id);
    // Comparison rows are polling summaries; the snapshot body stays on the detail endpoint.
    for (const run of comparison.runs) expect(run).not.toHaveProperty('executionSnapshot');
    expect(comparison.modelVersions).toEqual([
      expect.objectContaining({
        id: modelVersion.id,
        modelName: 'Speech Model',
        version: '1',
      }),
    ]);
    expect(comparison.datasetVersions).toEqual([
      expect.objectContaining({
        id: datasetVersion.id,
        name: 'eval-set',
        version: 'v2',
      }),
    ]);
    const row = (namespace: string, key: string) =>
      comparison.rows.find((item) => item.namespace === namespace && item.key === key);
    expect(row('metrics', 'wer')).toEqual({
      namespace: 'metrics',
      key: 'wer',
      values: [0.15, 'NaN', 0.2],
      deltaFromBaseline: [expect.closeTo(-0.05), null, 0],
      relativeDeltaFromBaseline: [expect.closeTo(-0.25), null, 0],
    });
    expect(row('metrics', 'cer')?.deltaFromBaseline).toEqual([null, null, 0]);
    expect(row('params', 'lr')?.values).toEqual([0.01, null, 0.1]);
    expect(row('params', 'layers')?.values).toEqual(['[1,2]', null, null]);
    expect(row('tags', 'team')?.values).toEqual(['asr', null, null]);
    expect(comparison).not.toHaveProperty('history');

    const selected = await entity<RunComparison>(
      await compare({
        runIds,
        metricKeys: ['cer', 'missing'],
        includeHistory: true,
      }),
      200,
    );
    expect(
      selected.rows.filter((item) => item.namespace === 'metrics').map((item) => item.key),
    ).toEqual(['cer', 'missing']);
    expect(selected.rows.find((item) => item.key === 'cer')).not.toHaveProperty(
      'deltaFromBaseline',
    );
    expect(selected.history?.map((series) => [series.runId, series.key])).toEqual(
      runIds.flatMap((id) => [
        [id, 'cer'],
        [id, 'missing'],
      ]),
    );
  });

  it('他ProjectのRunは404、件数・重複・基準Runの誤りは422', async () => {
    const runs = await Promise.all(
      Array.from({ length: 3 }, (_, index) => createRun({ name: `run-${index}` })),
    );
    const ids = runs.map((run) => run.id);
    const foreign = await createOtherProjectRun();
    expect((await compare({ runIds: [ids[0]!, foreign.id] })).status).toBe(404);
    expect((await compareCsv({ runIds: [ids[0]!, foreign.id] })).status).toBe(404);

    expect((await compare({ runIds: [ids[0]!] })).status).toBe(422);
    expect((await compare({ runIds: [ids[0]!, ids[0]!] })).status).toBe(422);
    expect((await compare({ runIds: ids.slice(0, 2), baselineRunId: ids[2]! })).status).toBe(422);
    const fiftyOne = Array.from({ length: 51 }, () => crypto.randomUUID());
    const tooMany = await compare({ runIds: fiftyOne });
    expect(tooMany.status).toBe(422);
    expect(((await tooMany.json()) as { code: string }).code).toBe('invalid_request');
    expect((await compareCsv({ runIds: fiftyOne })).status).toBe(422);
  });

  it('比較CSVは項目×Runの表で、ヘッダ・エスケープ・差分行・添付ヘッダを付ける', async () => {
    const baseline = await createRun({
      name: 'base,line',
      parameters: { note: '=1+1' },
    });
    const candidate = await createRun({
      name: '候補 "A"',
      parameters: { note: 'plain' },
    });
    await logMetrics(baseline.id, { loss: 0.5 });
    await logMetrics(candidate.id, { loss: -0.25 });

    const response = await compareCsv({
      runIds: [candidate.id, baseline.id],
      baselineRunId: baseline.id,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('text/csv; charset=utf-8');
    expect(response.headers.get('Content-Disposition')).toMatch(
      /^attachment; filename="run-comparison-\d{8}T\d{6}\.csv"/,
    );
    const lines = csvLines(await responseCsv(response));
    expect(lines[0]).toBe('name,"候補 ""A""","base,line"');
    expect(lines[1]).toBe(`id,${candidate.id},${baseline.id}`);
    expect(lines).toContain('experiment,Test Experiment,Test Experiment');
    expect(lines).toContain('baseline,false,true');
    // String parameters get the formula guard; numeric metrics such as -0.25 do not.
    expect(lines).toContain("params.note,plain,'=1+1");
    expect(lines).toContain('metrics.loss,-0.25,0.5');
    expect(lines).toContain('metrics.loss (delta),-0.75,0');
  });

  it('検索結果のCSVはRun 1件1行で、検索条件・列順・数式対策を守る', async () => {
    const { modelVersion, datasetVersion } = await evaluationReferences();
    const older = await createRun({
      name: '@older',
      kind: 'evaluation',
      parameters: { lr: 0.1 },
      tags: { team: 'asr' },
      modelVersionId: modelVersion.id,
      inputDatasetVersionIds: [datasetVersion.id],
    });
    const newer = await createRun({
      name: 'newer',
      parameters: { optimizer: 'adam' },
    });
    await createRun({ name: 'excluded' });
    await logMetrics(older.id, { wer: 0.3 });
    await logMetrics(newer.id, { wer: 0.2 });

    const response = await exportCsv({ filter: 'metrics.wer > 0', limit: 1 });
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('text/csv; charset=utf-8');
    expect(response.headers.get('Content-Disposition')).toMatch(/^attachment; filename="runs-/);
    expect(response.headers.get(RUN_EXPORT_TRUNCATED_HEADER)).toBe('false');
    const lines = csvLines(await responseCsv(response));
    expect(lines[0]).toBe(
      'id,name,experiment,kind,status,created,ended,modelVersion,datasetVersions,' +
        'params.lr,params.optimizer,metrics.wer,tags.team',
    );
    // limit is a paging field of /runs/search and does not shorten an export.
    expect(lines).toHaveLength(3);
    expect(lines[1]).toBe(
      `${newer.id},newer,Test Experiment,training,queued,${newer.createdAt},,,,,adam,0.2,`,
    );
    expect(lines[2]).toBe(
      `${older.id},'@older,Test Experiment,evaluation,queued,${older.createdAt},,` +
        `Speech Model@1,speech/eval-set@v2,0.1,,0.3,asr`,
    );

    expect((await exportCsv({ filter: 'metrics.wer >' })).status).toBe(400);
  });

  it('上限を超えた出力は打ち切り、ヘッダと末尾の行で示す', async () => {
    for (const name of ['a', 'b', 'c', 'd']) await createRun({ name });
    const limited = createApplication({
      config: { ...harness.config, csvExportMaxRows: 3 },
      database: harness.database,
      stores: harness.stores,
    });
    try {
      const response = await exportCsv({}, { app: limited.app });
      expect(response.headers.get(RUN_EXPORT_TRUNCATED_HEADER)).toBe('true');
      const lines = csvLines(await responseCsv(response));
      expect(lines).toHaveLength(1 + 3 + 1);
      expect(lines.slice(1, 4).map((line) => line.split(',')[1])).toEqual(['d', 'c', 'b']);
      expect(lines.at(-1)).toMatch(/^# truncated: 3行/);
    } finally {
      await limited.outbox.stop();
    }
  });

  it('viewerとread tokenは出力でき、非メンバーと他Project限定tokenは403', async () => {
    const runs = [await createRun({ name: 'one' }), await createRun({ name: 'two' })];
    const runIds = runs.map((run) => run.id);
    const readable = await mintToken({
      projectId: fixture.project.id,
      scopes: ['read'],
    });
    expect((await compareCsv({ runIds }, { token: readable })).status).toBe(200);
    expect((await exportCsv({}, { credentials: { token: readable } })).status).toBe(200);

    const outsider = { cookie: fixture.outsider.cookie };
    expect((await compare({ runIds }, outsider)).status).toBe(403);
    expect((await exportCsv({}, { credentials: outsider })).status).toBe(403);
    const foreign = await createOtherProjectRun();
    const restricted = await mintToken({
      projectId: foreign.projectId,
      scopes: ['read'],
    });
    expect((await compare({ runIds }, { token: restricted })).status).toBe(403);
    expect((await compareCsv({ runIds }, { token: restricted })).status).toBe(403);
    expect((await exportCsv({}, { credentials: { token: restricted } })).status).toBe(403);
  });

  it('出力を読み終える前でもDB接続を握り続けず、全ページを重複なく書く', async () => {
    await harness.database.query(
      `INSERT INTO runs(project_id,experiment_id,name,kind,created_by,created_at)
      SELECT $1,$2,'bulk-'||lpad(n::text,4,'0'),'training',$3,
        timestamptz '2026-01-01T00:00:00Z' + make_interval(secs => n)
      FROM generate_series(1,$4) AS n`,
      [fixture.project.id, fixture.experiment.id, fixture.editor.userId, MULTI_PAGE_RUN_COUNT],
    );
    const response = await exportCsv({});
    const reader = response.body!.getReader();
    const decoder = csvDecoder();
    let csv = decoder.decode((await reader.read()).value, { stream: true });
    csv += decoder.decode((await reader.read()).value, { stream: true });
    // Between chunks the export waits for the client without a checked-out connection.
    expect(harness.database.totalCount - harness.database.idleCount).toBe(0);
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read())
      csv += decoder.decode(chunk.value, { stream: true });
    const names = csvLines(csv + decoder.decode())
      .slice(1)
      .map((line) => line.split(',')[1]);
    expect(names).toHaveLength(MULTI_PAGE_RUN_COUNT);
    expect(new Set(names).size).toBe(MULTI_PAGE_RUN_COUNT);
    expect(names[0]).toBe('bulk-1200');
  });
});
