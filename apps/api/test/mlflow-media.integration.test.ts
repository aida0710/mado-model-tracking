import type { MediaTablePage, RunMediaKeySummary, RunMediaPage } from '@mmt/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { backfillRunMedia } from '../src/scripts/backfillRunMedia.js';
import { artifactFixture, transferUrl } from './mlflow-artifacts-fixtures.js';
import { createHarness, entity, request, testDatabaseUrl, type Harness } from './harness.js';

type Fixture = Awaited<ReturnType<typeof artifactFixture>>;

// Names as MLflow 3.17.0 (+) and 3.0.0 (%) write them for log_image(key=, step=).
function imagePath(options: { key: string; step: number; separator?: '+' | '%'; id?: string }): string {
  const separator = options.separator ?? '+';
  const key = options.key.replaceAll('/', separator === '+' ? '~' : '#');
  const id = options.id ?? 'b1b2c3d4-0000-4000-8000-000000000001';
  return `images/${key}${separator}step${separator}${options.step}${separator}timestamp${separator}1728370000123${separator}${id}.png`;
}

function compressedPath(path: string): string {
  const separator = path.includes('+step+') ? '+' : '%';
  return path.replace(/\.png$/, `${separator}compressed.webp`);
}

describe.skipIf(!testDatabaseUrl)('MLflowのlog_image・log_tableの索引（独立PostgreSQL）', () => {
  let harness: Harness;
  let fixture: Fixture;
  beforeAll(async () => {
    harness = await createHarness();
  });
  beforeEach(async () => {
    await harness.reset();
    fixture = await artifactFixture(harness);
  });
  afterAll(async () => {
    await harness?.close();
  });

  async function putMlflowArtifact(path: string, content: string, mimeType: string): Promise<void> {
    const response = await request(harness.app, transferUrl(fixture.mlflowPath, fixture.runRoot, path), {
      method: 'PUT',
      cookie: fixture.editor.cookie,
      binary: content,
      headers: { 'Content-Type': mimeType },
    });
    expect(response.status, await response.clone().text()).toBe(200);
  }

  async function listMedia(query = ''): Promise<RunMediaPage> {
    return entity<RunMediaPage>(
      await request(harness.app, `${fixture.basePath}/runs/${fixture.run.id}/media${query}`, {
        cookie: fixture.viewer.cookie,
      }),
      200,
    );
  }

  async function artifactIdAt(path: string): Promise<string> {
    const { rows } = await harness.database.query<{ id: string }>(
      'SELECT id FROM artifacts WHERE run_id=$1 AND path=$2 ORDER BY created_at DESC LIMIT 1',
      [fixture.run.id, path],
    );
    return rows[0]!.id;
  }

  it('MLflow 3.17の画像とcompressed.webpは1件のimageとthumbnailになる', async () => {
    const image = imagePath({ key: 'eval/mel', step: 3 });
    await putMlflowArtifact(image, 'png bytes', 'image/png');
    await putMlflowArtifact(compressedPath(image), 'webp bytes', 'image/webp');
    const { items } = await listMedia();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      key: 'eval/mel',
      step: 3,
      kind: 'image',
      source: 'mlflow',
      path: image,
      artifactId: await artifactIdAt(image),
      thumbnailArtifactId: await artifactIdAt(compressedPath(image)),
      metadata: { timestamp: 1728370000123 },
    });
    expect(items[0]!.thumbnailContentUrl).toContain(items[0]!.thumbnailArtifactId!);
  });

  it('compressed.webpが先に届いても本体の行に付く', async () => {
    const image = imagePath({ key: 'mel', step: 0 });
    await putMlflowArtifact(compressedPath(image), 'webp bytes', 'image/webp');
    await putMlflowArtifact(image, 'png bytes', 'image/png');
    const { items } = await listMedia();
    expect(items).toHaveLength(1);
    expect(items[0]!.thumbnailArtifactId).toBe(await artifactIdAt(compressedPath(image)));
  });

  it('MLflow 3.0の%区切りもstep順の一覧に入り、同じpathの再送は1件のまま', async () => {
    for (const step of [20, 0, 10])
      await putMlflowArtifact(
        imagePath({ key: 'eval/mel', step, separator: '%', id: `g000000${step % 10}-0000-4000-8000-00000000000${step / 10}` }),
        `png ${step}`,
        'image/png',
      );
    const reuploaded = imagePath({ key: 'eval/mel', step: 0, separator: '%', id: 'g0000000-0000-4000-8000-000000000000' });
    await putMlflowArtifact(reuploaded, 'png 0 again', 'image/png');
    const { items } = await listMedia('?key=eval/mel');
    expect(items.map((item) => item.step)).toEqual([0, 10, 20]);
    expect(items[0]!.artifactId).toBe(await artifactIdAt(reuploaded));
  });

  it('tag mlflow.loggedArtifactsの表がstep 0の表として一覧・keys・表APIに出る', async () => {
    await putMlflowArtifact(
      'tables/eval.json',
      JSON.stringify({ columns: ['text', 'score'], data: [['a', 0.5], ['b', 0.25]] }),
      'application/json',
    );
    const tagged = await request(harness.app, `${fixture.mlflowPath}/api/2.0/mlflow/runs/set-tag`, {
      method: 'POST',
      cookie: fixture.editor.cookie,
      body: {
        run_id: fixture.run.id,
        key: 'mlflow.loggedArtifacts',
        value: JSON.stringify([
          { path: 'tables/eval.json', type: 'table' },
          { path: 'tables/missing.json', type: 'table' },
        ]),
      },
    });
    expect(tagged.status).toBe(200);
    const { items } = await listMedia();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ key: 'tables/eval.json', step: 0, kind: 'table', source: 'mlflow' });
    expect((await listMedia()).items[0]!.id).toBe(items[0]!.id);
    expect((await listMedia('?kind=image')).items).toEqual([]);

    const keys = await entity<{ items: RunMediaKeySummary[] }>(
      await request(harness.app, `${fixture.basePath}/runs/${fixture.run.id}/media/keys`, { cookie: fixture.viewer.cookie }),
      200,
    );
    expect(keys.items).toEqual([{ key: 'tables/eval.json', kind: 'table', count: 1, minStep: 0, maxStep: 0 }]);

    const table = await entity<MediaTablePage>(
      await request(harness.app, `${fixture.basePath}/runs/${fixture.run.id}/media/${items[0]!.id}/table`, {
        cookie: fixture.viewer.cookie,
      }),
      200,
    );
    expect(table).toEqual({
      columns: [
        { name: 'text', type: 'text' },
        { name: 'score', type: 'number' },
      ],
      rows: [
        ['a', 0.5],
        ['b', 0.25],
      ],
      totalRows: 2,
      offset: 0,
    });
  });

  it('索引に失敗してもArtifactは保存され、backfillで後から入り2回目は増えない', async () => {
    await harness.database.query(`CREATE FUNCTION reject_run_media() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'index unavailable'; END; $$`);
    await harness.database.query(
      'CREATE TRIGGER reject_run_media BEFORE INSERT ON run_media FOR EACH ROW EXECUTE FUNCTION reject_run_media()',
    );
    const image = imagePath({ key: 'mel', step: 7 });
    try {
      await putMlflowArtifact(image, 'png bytes', 'image/png');
      await putMlflowArtifact(compressedPath(image), 'webp bytes', 'image/webp');
    } finally {
      await harness.database.query('DROP TRIGGER reject_run_media ON run_media');
      await harness.database.query('DROP FUNCTION reject_run_media()');
    }
    expect(await artifactIdAt(image)).toBeDefined();
    expect((await listMedia()).items).toEqual([]);

    await backfillRunMedia(harness.database);
    const { items } = await listMedia();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ key: 'mel', step: 7, thumbnailArtifactId: await artifactIdAt(compressedPath(image)) });
    await backfillRunMedia(harness.database);
    const {
      rows: [count],
    } = await harness.database.query<{ count: string }>('SELECT count(*) FROM run_media');
    expect(Number(count!.count)).toBe(1);
  });
});
