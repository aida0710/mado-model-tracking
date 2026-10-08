import { randomUUID } from 'node:crypto';
import type {
  Artifact,
  Job,
  MediaCompareGrid,
  MediaTableMediaCell,
  MediaTablePage,
  Project,
  Run,
  RunMedia,
  RunMediaKeySummary,
  RunMediaList,
  RunMediaPage,
  WorkerJob,
} from '@mmt/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { executionFixture } from './fixtures.js';
import { createHarness, entity, request, testDatabaseUrl, type Harness } from './harness.js';

type Fixture = Awaited<ReturnType<typeof executionFixture>>;
type Credential = { cookie?: string; token?: string };

describe.skipIf(!testDatabaseUrl)('Runのmedia（独立PostgreSQL）', () => {
  let harness: Harness;
  let fixture: Fixture;
  let run: Run;
  beforeAll(async () => {
    harness = await createHarness();
  });
  beforeEach(async () => {
    await harness.reset();
    fixture = await executionFixture(harness);
    run = await fixture.newRun('Media');
  });
  afterAll(async () => {
    await harness?.close();
  });

  async function saveArtifact(
    runId: string,
    path: string,
    options: { content?: string; mimeType?: string; basePath?: string; cookie?: string } = {},
  ): Promise<Artifact> {
    return entity<Artifact>(
      await request(
        harness.app,
        `${options.basePath ?? fixture.basePath}/runs/${runId}/artifacts?path=${encodeURIComponent(path)}`,
        {
          method: 'PUT',
          cookie: options.cookie ?? fixture.editor.cookie,
          binary: options.content ?? `content of ${path}`,
          headers: { 'Content-Type': options.mimeType ?? 'application/octet-stream' },
        },
      ),
    );
  }

  function registerMedia(
    runId: string,
    items: Record<string, unknown>[],
    credential: Credential = { cookie: fixture.editor.cookie },
  ) {
    return request(harness.app, `${fixture.basePath}/runs/${runId}/media`, {
      method: 'POST',
      ...credential,
      body: { items },
    });
  }

  async function registered(runId: string, items: Record<string, unknown>[]): Promise<RunMedia[]> {
    return (await entity<RunMediaList>(await registerMedia(runId, items))).items;
  }

  async function listMedia(runId: string, query = '', credential: Credential = { cookie: fixture.viewer.cookie }) {
    return request(harness.app, `${fixture.basePath}/runs/${runId}/media${query}`, credential);
  }

  async function compare(body: Record<string, unknown>): Promise<Response> {
    return request(harness.app, `${fixture.basePath}/media/compare`, {
      method: 'POST',
      cookie: fixture.viewer.cookie,
      body,
    });
  }

  async function errorCode(response: Response): Promise<string | undefined> {
    return ((await response.json()) as { code?: string }).code;
  }

  describe('登録', () => {
    it('同じidの再送は1件のまま既存を返し、中身が違えば409', async () => {
      const audio = await saveArtifact(run.id, 'samples/step-1.wav', { mimeType: 'audio/wav' });
      const id = randomUUID();
      const item = { id, key: 'eval/audio', step: 1, kind: 'audio', artifactId: audio.id, caption: '1 step目', metadata: { sampleRate: 16000 } };
      const [first] = await registered(run.id, [item]);
      expect(first).toMatchObject({
        id,
        runId: run.id,
        key: 'eval/audio',
        step: 1,
        kind: 'audio',
        artifactId: audio.id,
        thumbnailArtifactId: null,
        caption: '1 step目',
        metadata: { sampleRate: 16000 },
        source: 'native',
        path: 'samples/step-1.wav',
        mimeType: 'audio/wav',
        contentUrl: `/api/projects/${fixture.project.id}/artifacts/${audio.id}/content`,
      });
      const [resent] = await registered(run.id, [item]);
      expect(resent).toEqual(first);
      const listed = await entity<RunMediaPage>(await listMedia(run.id), 200);
      expect(listed.items).toHaveLength(1);

      const changed = await registerMedia(run.id, [{ ...item, caption: '別の説明' }]);
      expect(changed.status).toBe(409);
      expect(await errorCode(changed)).toBe('media_conflict');
    });

    it('同じkey・step・Artifactを別のidで送ると409', async () => {
      const image = await saveArtifact(run.id, 'samples/a.png', { mimeType: 'image/png' });
      await registered(run.id, [{ key: 'mel', step: 0, kind: 'image', artifactId: image.id }]);
      const duplicate = await registerMedia(run.id, [{ key: 'mel', step: 0, kind: 'image', artifactId: image.id }]);
      expect(duplicate.status).toBe(409);
      expect(await errorCode(duplicate)).toBe('media_exists');
    });

    it('別RunのArtifactと保存の終わっていないArtifactは422', async () => {
      const otherRun = await fixture.newRun('Other');
      const foreign = await saveArtifact(otherRun.id, 'samples/a.wav', { mimeType: 'audio/wav' });
      const response = await registerMedia(run.id, [{ key: 'a', step: 0, kind: 'audio', artifactId: foreign.id }]);
      expect(response.status).toBe(422);
      expect(await errorCode(response)).toBe('media_artifact_run');

      const upload = await entity<{ id: string }>(
        await request(harness.app, `${fixture.basePath}/artifact-uploads`, {
          method: 'POST',
          cookie: fixture.editor.cookie,
          body: { path: 'samples/long.wav', runId: run.id, expectedSize: 10, partSize: 5 * 1024 * 1024 },
        }),
      );
      const unfinished = await registerMedia(run.id, [{ key: 'a', step: 0, kind: 'audio', artifactId: upload.id }]);
      expect(unfinished.status).toBe(422);
      expect(await errorCode(unfinished)).toBe('media_artifact_unavailable');
    });

    it('kindとMIME typeが食い違うと422、同じ要求内の重複も422', async () => {
      const audio = await saveArtifact(run.id, 'samples/a.wav', { mimeType: 'audio/wav' });
      const mismatch = await registerMedia(run.id, [{ key: 'a', step: 0, kind: 'image', artifactId: audio.id }]);
      expect(await errorCode(mismatch)).toBe('media_kind_mismatch');
      const item = { key: 'a', step: 0, kind: 'audio', artifactId: audio.id };
      const duplicate = await registerMedia(run.id, [item, item]);
      expect(duplicate.status).toBe(422);
      expect(await errorCode(duplicate)).toBe('media_duplicate_item');
    });

    it('壊れた表は422 media_table_invalid、parquetは422 unsupported_table_format', async () => {
      const broken = await saveArtifact(run.id, 'tables/broken.json', { content: '{"columns": [', mimeType: 'application/json' });
      const invalid = await registerMedia(run.id, [{ key: 't', step: 0, kind: 'table', artifactId: broken.id }]);
      expect(invalid.status).toBe(422);
      expect(await errorCode(invalid)).toBe('media_table_invalid');
      const parquet = await saveArtifact(run.id, 'tables/a.parquet', { content: 'PAR1' });
      const unsupported = await registerMedia(run.id, [{ key: 't', step: 0, kind: 'table', artifactId: parquet.id }]);
      expect(await errorCode(unsupported)).toBe('unsupported_table_format');
    });

    it('viewerは読めるが登録は403、Projectの外の利用者は403', async () => {
      const audio = await saveArtifact(run.id, 'samples/a.wav', { mimeType: 'audio/wav' });
      const denied = await registerMedia(run.id, [{ key: 'a', step: 0, kind: 'audio', artifactId: audio.id }], {
        cookie: fixture.viewer.cookie,
      });
      expect(denied.status).toBe(403);
      expect((await listMedia(run.id)).status).toBe(200);
      expect((await listMedia(run.id, '', { cookie: fixture.outsider.cookie })).status).toBe(403);
      expect((await listMedia(run.id, '/keys', { cookie: fixture.outsider.cookie })).status).toBe(403);
    });

    it('別ProjectのRunは404', async () => {
      const other = await entity<Project>(
        await request(harness.app, '/api/projects', {
          method: 'POST',
          cookie: fixture.administrator.cookie,
          body: { name: 'Other Project' },
        }),
      );
      const response = await request(harness.app, `/api/projects/${other.id}/runs/${run.id}/media`, {
        cookie: fixture.administrator.cookie,
      });
      expect(response.status).toBe(404);
    });
  });

  describe('Job token と終端', () => {
    async function claimJob(target: Run): Promise<WorkerJob> {
      await entity<Job>(
        await request(harness.app, `${fixture.basePath}/jobs`, {
          method: 'POST',
          cookie: fixture.editor.cookie,
          body: { runId: target.id, targetId: fixture.target.id },
        }),
      );
      return (
        await entity<{ item: WorkerJob }>(
          await request(harness.app, '/api/worker/claim', {
            method: 'POST',
            token: fixture.workerToken,
            body: { workerId: 'media-worker' },
          }),
          200,
        )
      ).item;
    }

    it('Job tokenは自分のRunに登録でき、他のRunには403', async () => {
      const otherRun = await fixture.newRun('Other');
      const own = await saveArtifact(run.id, 'samples/own.wav', { mimeType: 'audio/wav' });
      const foreign = await saveArtifact(otherRun.id, 'samples/foreign.wav', { mimeType: 'audio/wav' });
      const workerJob = await claimJob(run);
      const token = { token: workerJob.jobToken! };
      expect((await registerMedia(run.id, [{ key: 'a', step: 0, kind: 'audio', artifactId: own.id }], token)).status).toBe(201);
      const denied = await registerMedia(otherRun.id, [{ key: 'a', step: 0, kind: 'audio', artifactId: foreign.id }], token);
      expect(denied.status).toBe(403);
    });

    it('Jobの終わったRunへの新しい登録は409 run_finalized、同じidの再送は既存を返す', async () => {
      const audio = await saveArtifact(run.id, 'samples/a.wav', { mimeType: 'audio/wav' });
      const late = await saveArtifact(run.id, 'samples/late.wav', { mimeType: 'audio/wav' });
      const id = randomUUID();
      await registered(run.id, [{ id, key: 'a', step: 0, kind: 'audio', artifactId: audio.id }]);
      const workerJob = await claimJob(run);
      await entity(
        await request(harness.app, `/api/worker/jobs/${workerJob.job.id}/complete`, {
          method: 'POST',
          token: fixture.workerToken,
          body: { leaseId: workerJob.job.leaseId, status: 'finished', exitCode: 0 },
        }),
        200,
      );
      const finalized = await registerMedia(run.id, [{ key: 'a', step: 1, kind: 'audio', artifactId: late.id }]);
      expect(finalized.status).toBe(409);
      expect(await errorCode(finalized)).toBe('run_finalized');
      const resent = await registerMedia(run.id, [{ id, key: 'a', step: 0, kind: 'audio', artifactId: audio.id }]);
      expect(resent.status).toBe(201);
    });
  });

  describe('一覧と比較', () => {
    async function seedSteps(target: Run, key: string, steps: number[]): Promise<RunMedia[]> {
      const items = [];
      for (const step of steps) {
        const artifact = await saveArtifact(target.id, `${key}/step-${step}.wav`, { mimeType: 'audio/wav' });
        items.push({ key, step, kind: 'audio', artifactId: artifact.id });
      }
      return registered(target.id, items);
    }

    it('keyごとの件数とstep範囲、stepの範囲指定とcursorで頁を送る', async () => {
      await seedSteps(run, 'eval/audio', [30, 10, 20, 0]);
      await seedSteps(run, 'train/audio', [5]);
      const keys = await entity<{ items: RunMediaKeySummary[] }>(await listMedia(run.id, '/keys'), 200);
      expect(keys.items).toEqual([
        { key: 'eval/audio', kind: 'audio', count: 4, minStep: 0, maxStep: 30 },
        { key: 'train/audio', kind: 'audio', count: 1, minStep: 5, maxStep: 5 },
      ]);

      const first = await entity<RunMediaPage>(
        await listMedia(run.id, '?key=eval/audio&stepFrom=10&stepTo=30&limit=2'),
        200,
      );
      expect(first.items.map((item) => item.step)).toEqual([10, 20]);
      expect(first.nextCursor).toBeDefined();
      const second = await entity<RunMediaPage>(
        await listMedia(run.id, `?key=eval/audio&stepFrom=10&stepTo=30&limit=2&cursor=${first.nextCursor}`),
        200,
      );
      expect(second.items.map((item) => item.step)).toEqual([30]);
      expect(second.nextCursor).toBeUndefined();

      const all = await entity<RunMediaPage>(await listMedia(run.id), 200);
      expect(all.items.map((item) => `${item.step}:${item.key}`)).toEqual([
        '0:eval/audio',
        '5:train/audio',
        '10:eval/audio',
        '20:eval/audio',
        '30:eval/audio',
      ]);
      expect((await listMedia(run.id, '?cursor=broken')).status).toBe(400);
    });

    it('media情報のある音声は一覧に同梱する', async () => {
      const wav = Buffer.alloc(44 + 3200);
      wav.write('RIFF', 0);
      wav.writeUInt32LE(36 + 3200, 4);
      wav.write('WAVEfmt ', 8);
      wav.writeUInt32LE(16, 16);
      wav.writeUInt16LE(1, 20);
      wav.writeUInt16LE(1, 22);
      wav.writeUInt32LE(16000, 24);
      wav.writeUInt32LE(32000, 28);
      wav.writeUInt16LE(2, 32);
      wav.writeUInt16LE(16, 34);
      wav.write('data', 36);
      wav.writeUInt32LE(3200, 40);
      const artifact = await entity<Artifact>(
        await request(harness.app, `${fixture.basePath}/runs/${run.id}/artifacts?path=samples/tone.wav`, {
          method: 'PUT',
          cookie: fixture.editor.cookie,
          binary: new Uint8Array(wav),
          headers: { 'Content-Type': 'audio/wav' },
        }),
      );
      await registered(run.id, [{ key: 'tone', step: 0, kind: 'audio', artifactId: artifact.id }]);
      const [item] = (await entity<RunMediaPage>(await listMedia(run.id), 200)).items;
      expect(item!.mediaInfo).toMatchObject({ artifactId: artifact.id, sampleRate: 16000, channels: 1 });
    });

    it('複数Run×stepの格子を返し、無い所はnullで近いstepを埋めない', async () => {
      const second = await fixture.newRun('Second');
      await seedSteps(run, 'eval/audio', [0, 10, 20]);
      await seedSteps(second, 'eval/audio', [0, 15]);
      const grid = await entity<MediaCompareGrid>(
        await compare({ runIds: [second.id, run.id], key: 'eval/audio', steps: [10, 0, 15] }),
        200,
      );
      expect(grid.steps).toEqual([10, 0, 15]);
      expect(grid.rows.map((row) => row.runId)).toEqual([second.id, run.id]);
      expect(grid.rows[0]!.cells.map((cell) => cell?.map((item) => item.step) ?? null)).toEqual([null, [0], [15]]);
      expect(grid.rows[1]!.cells.map((cell) => cell?.map((item) => item.step) ?? null)).toEqual([[10], [0], null]);

      const latest = await entity<MediaCompareGrid>(await compare({ runIds: [run.id, second.id], key: 'eval/audio' }), 200);
      expect(latest.steps).toBeNull();
      expect(latest.rows.map((row) => row.cells[0]?.[0]?.step)).toEqual([20, 15]);

      const third = await fixture.newRun('Without media');
      const missing = await entity<MediaCompareGrid>(await compare({ runIds: [third.id], key: 'eval/audio' }), 200);
      expect(missing.rows[0]!.cells).toEqual([null]);
    });

    it('比較の上限・重複と他ProjectのRunを拒否する', async () => {
      const tooMany = Array.from({ length: 21 }, () => randomUUID());
      expect((await compare({ runIds: tooMany, key: 'a' })).status).toBe(422);
      expect((await compare({ runIds: [run.id, run.id], key: 'a' })).status).toBe(422);
      expect((await compare({ runIds: [run.id], key: 'a', steps: Array.from({ length: 51 }, (_, step) => step) })).status).toBe(422);
      expect((await compare({ runIds: [randomUUID()], key: 'a' })).status).toBe(404);
    });
  });

  describe('表', () => {
    it('頁送りと、画像セル・別Runの参照の解決', async () => {
      const otherRun = await fixture.newRun('Reference');
      const image = await saveArtifact(run.id, 'table_images/eval/a.png', { mimeType: 'image/png' });
      const thumbnail = await saveArtifact(run.id, 'table_images/eval/a.webp', { mimeType: 'image/webp' });
      const reference = await saveArtifact(otherRun.id, 'audio/ref.wav', { mimeType: 'audio/wav' });
      const otherProject = randomUUID();
      const rows = Array.from({ length: 5 }, (_, index) => [
        `sample-${index}`,
        index / 10,
        { type: 'image', filepath: 'table_images/eval/a.png', compressed_filepath: 'table_images/eval/a.webp' },
        index === 0
          ? `mmt-artifact://runs/${otherRun.id}/audio/ref.wav`
          : index === 1
            ? `mmt-artifact://projects/${otherProject}/runs/${otherRun.id}/audio/ref.wav`
            : `mmt-artifact://runs/${otherRun.id}/audio/missing-${index}.wav`,
      ]);
      const table = await saveArtifact(run.id, 'tables/eval.json', {
        mimeType: 'application/json',
        content: JSON.stringify({ columns: ['name', 'score', 'image', 'reference'], data: rows }),
      });
      const [media] = await registered(run.id, [{ key: 'eval/table', step: 3, kind: 'table', artifactId: table.id }]);
      const tableUrl = `${fixture.basePath}/runs/${run.id}/media/${media!.id}/table`;

      const page = await entity<MediaTablePage>(
        await request(harness.app, `${tableUrl}?offset=0&limit=2`, { cookie: fixture.viewer.cookie }),
        200,
      );
      expect(page.columns).toEqual([
        { name: 'name', type: 'text' },
        { name: 'score', type: 'number' },
        { name: 'image', type: 'image' },
        { name: 'reference', type: 'audio' },
      ]);
      expect(page.totalRows).toBe(5);
      expect(page.rows).toHaveLength(2);
      expect(page.rows[0]![2]).toEqual({
        type: 'image',
        runId: run.id,
        path: 'table_images/eval/a.png',
        artifactId: image.id,
        thumbnailArtifactId: thumbnail.id,
        error: null,
      } satisfies MediaTableMediaCell);
      expect(page.rows[0]![3]).toMatchObject({ runId: otherRun.id, artifactId: reference.id, error: null });
      expect(page.rows[1]![3]).toMatchObject({ artifactId: null, error: 'other_project' });

      const last = await entity<MediaTablePage>(
        await request(harness.app, `${tableUrl}?offset=4&limit=2`, { cookie: fixture.viewer.cookie }),
        200,
      );
      expect(last.rows).toHaveLength(1);
      expect(last.rows[0]![0]).toBe('sample-4');
      expect(last.rows[0]![3]).toMatchObject({ artifactId: null, error: 'not_found' });
      expect((await request(harness.app, `${tableUrl}?limit=201`, { cookie: fixture.viewer.cookie })).status).toBe(422);
    });

    it('50MiBを超える表は413、表でないmediaは422', async () => {
      const table = await saveArtifact(run.id, 'tables/big.json', {
        mimeType: 'application/json',
        content: JSON.stringify({ columns: ['a'], data: [[1]] }),
      });
      const audio = await saveArtifact(run.id, 'samples/a.wav', { mimeType: 'audio/wav' });
      const [tableMedia, audioMedia] = await registered(run.id, [
        { key: 'big', step: 0, kind: 'table', artifactId: table.id },
        { key: 'audio', step: 0, kind: 'audio', artifactId: audio.id },
      ]);
      // Writing 50MiB in a test is slow; the limit is decided from the recorded size alone.
      await harness.database.query('UPDATE artifacts SET size=$2 WHERE id=$1', [table.id, 50 * 1024 * 1024 + 1]);
      const tooLarge = await request(harness.app, `${fixture.basePath}/runs/${run.id}/media/${tableMedia!.id}/table`, {
        cookie: fixture.viewer.cookie,
      });
      expect(tooLarge.status).toBe(413);
      expect(await errorCode(tooLarge)).toBe('media_table_too_large');
      const notTable = await request(harness.app, `${fixture.basePath}/runs/${run.id}/media/${audioMedia!.id}/table`, {
        cookie: fixture.viewer.cookie,
      });
      expect(await errorCode(notTable)).toBe('media_not_table');
      const unknown = await request(harness.app, `${fixture.basePath}/runs/${run.id}/media/${randomUUID()}/table`, {
        cookie: fixture.viewer.cookie,
      });
      expect(unknown.status).toBe(404);
    });
  });
});
