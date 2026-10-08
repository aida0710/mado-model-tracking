import { createHash, randomUUID } from 'node:crypto';
import {
  ARTIFACT_MEDIA_INFO_BATCH_LIMIT,
  type Artifact,
  type ArtifactMediaInfo,
  type ArtifactUpload,
  type Project,
} from '@mmt/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApplication } from '../src/app.js';
import { flacFile, waveFile } from './audioFixtures.js';
import { artifactFixture, transferUrl } from './mlflow-artifacts-fixtures.js';
import { projectFixture } from './fixtures.js';
import { createHarness, entity, request, testDatabaseUrl, type Harness } from './harness.js';

type Fixture = Awaited<ReturnType<typeof projectFixture>>;

describe.skipIf(!testDatabaseUrl)('Artifactのmedia情報（独立PostgreSQL）', () => {
  let harness: Harness;
  let fixture: Fixture;

  function upload(
    path: string,
    body: Buffer,
    options: { mimeType?: string; app?: Harness['app'] } = {},
  ) {
    const endpoint = `${fixture.basePath}/artifacts?path=${encodeURIComponent(path)}`;
    return request(options.app ?? harness.app, endpoint, {
      method: 'PUT',
      cookie: fixture.editor.cookie,
      // A Uint8Array body keeps fetch from adding its own text/plain Content-Type.
      binary: new Uint8Array(body),
      headers: options.mimeType ? { 'Content-Type': options.mimeType } : {},
    });
  }

  function mediaInfo(projectId: string, artifactId: string, cookie = fixture.viewer.cookie) {
    return request(harness.app, `/api/projects/${projectId}/artifacts/${artifactId}/media-info`, {
      cookie,
    });
  }

  function mediaInfoBatch(artifactIds: string[], projectPath = fixture.basePath) {
    return request(
      harness.app,
      `${projectPath}/artifact-media-info?artifactIds=${artifactIds.join(',')}`,
      { cookie: fixture.viewer.cookie },
    );
  }

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

  it('WAVをuploadすると、ヘッダーから求めたmedia情報が保存される', async () => {
    const artifact = await entity<Artifact>(
      await upload('eval/sample.wav', waveFile({ sampleRate: 16000, channels: 2, frames: 32000 })),
    );
    expect(artifact.mimeType).toBe('audio/wav');
    expect(await entity<ArtifactMediaInfo>(await mediaInfo(fixture.project.id, artifact.id), 200)).toEqual({
      artifactId: artifact.id,
      durationSeconds: 2,
      sampleRate: 16000,
      channels: 2,
      bitsPerSample: 16,
      codec: 'pcm_s16le',
      source: 'header',
    });
  });

  it('FLACとaudio/x-wavも対象で、他の形式やContent-Typeでは保存しない', async () => {
    const flac = await entity<Artifact>(
      await upload(
        'audio/a.flac',
        flacFile({ sampleRate: 22050, channels: 1, bitsPerSample: 16, totalSamples: 22050 }),
      ),
    );
    const legacyWave = await entity<Artifact>(
      await upload('audio/b.bin', waveFile(), { mimeType: 'audio/x-wav' }),
    );
    const octetStream = await entity<Artifact>(
      await upload('audio/c.bin', waveFile(), { mimeType: 'application/octet-stream' }),
    );
    expect(await entity(await mediaInfo(fixture.project.id, flac.id), 200)).toMatchObject({
      codec: 'flac',
      durationSeconds: 1,
    });
    expect((await mediaInfo(fixture.project.id, legacyWave.id)).status).toBe(200);
    expect((await mediaInfo(fixture.project.id, octetStream.id)).status).toBe(404);
  });

  it('壊れたWAVでもArtifactは保存され、media情報は無い', async () => {
    const artifact = await entity<Artifact>(
      await upload('broken.wav', Buffer.from('RIFF....WAVEnot-a-chunk')),
    );
    const metadata = await request(harness.app, `${fixture.basePath}/artifacts/${artifact.id}`, {
      cookie: fixture.viewer.cookie,
    });
    expect(metadata.status).toBe(200);
    expect(await entity(await mediaInfo(fixture.project.id, artifact.id), 404)).toMatchObject({
      code: 'not_found',
    });
  });

  it('保存先からヘッダーを読めなくてもArtifactの保存は成功する', async () => {
    const failingRead = createApplication({
      config: harness.config,
      database: harness.database,
      stores: {
        ...harness.stores,
        read: () => Promise.reject(new Error('storage unavailable')),
      },
    });
    const artifact = await entity<Artifact>(
      await upload('eval/sample.wav', waveFile(), { app: failingRead.app }),
    );
    const { rows } = await harness.database.query('SELECT id FROM artifacts WHERE id=$1', [
      artifact.id,
    ]);
    expect(rows).toHaveLength(1);
    expect((await mediaInfo(fixture.project.id, artifact.id)).status).toBe(404);
  });

  it('upload sessionで登録したWAVにもmedia情報が入る', async () => {
    const content = waveFile({ sampleRate: 8000, frames: 4000 });
    const session = await entity<ArtifactUpload>(
      await request(harness.app, `${fixture.basePath}/artifact-uploads`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: {
          path: 'eval/session.wav',
          expectedSize: content.length,
          expectedSha256: createHash('sha256').update(content).digest('hex'),
        },
      }),
    );
    await entity(
      await request(harness.app, `${fixture.basePath}/artifact-uploads/${session.id}/parts/1`, {
        method: 'PUT',
        cookie: fixture.editor.cookie,
        // app.request does not derive Content-Length, which the part size check requires.
        headers: { 'Content-Length': String(content.length) },
        binary: new Uint8Array(content),
      }),
      200,
    );
    await entity(
      await request(harness.app, `${fixture.basePath}/artifact-uploads/${session.id}/complete`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
      }),
      202,
    );
    expect(await harness.artifactUploadFinalizer.finalizeBatch()).toBe(1);
    expect(await entity(await mediaInfo(fixture.project.id, session.id), 200)).toMatchObject({
      artifactId: session.id,
      durationSeconds: 0.5,
      sampleRate: 8000,
    });
  });

  it('MLflowのArtifact uploadで登録したWAVにもmedia情報が入る', async () => {
    const mlflow = await artifactFixture(harness);
    const response = await request(
      harness.app,
      transferUrl(mlflow.mlflowPath, mlflow.runRoot, 'audio/mlflow.wav'),
      {
        method: 'PUT',
        cookie: mlflow.editor.cookie,
        binary: new Uint8Array(waveFile({ sampleRate: 44100, frames: 44100 })),
      },
    );
    expect(response.status).toBe(200);
    const {
      rows: [stored],
    } = await harness.database.query<{ id: string }>(
      'SELECT id FROM artifacts WHERE project_id=$1 AND run_id=$2',
      [mlflow.project.id, mlflow.run.id],
    );
    expect(
      await entity(await mediaInfo(mlflow.project.id, stored!.id, mlflow.viewer.cookie), 200),
    ).toMatchObject({ durationSeconds: 1, sampleRate: 44100, codec: 'pcm_s16le' });
  });

  it('他Projectからは404で、Projectに属さないユーザーは参照できない', async () => {
    const artifact = await entity<Artifact>(await upload('eval/sample.wav', waveFile()));
    const other = await entity<Project>(
      await request(harness.app, '/api/projects', {
        method: 'POST',
        cookie: fixture.administrator.cookie,
        body: { name: 'Other Project' },
      }),
    );
    expect(
      (await mediaInfo(other.id, artifact.id, fixture.administrator.cookie)).status,
    ).toBe(404);
    expect(
      await entity<{ items: ArtifactMediaInfo[] }>(
        await request(
          harness.app,
          `/api/projects/${other.id}/artifact-media-info?artifactIds=${artifact.id}`,
          { cookie: fixture.administrator.cookie },
        ),
        200,
      ),
    ).toEqual({ items: [] });
    expect((await mediaInfo(fixture.project.id, artifact.id, fixture.outsider.cookie)).status).toBe(
      403,
    );
  });

  it('まとめ取得は見つかったものだけを返し、上限を超えるIDは422', async () => {
    const first = await entity<Artifact>(await upload('a.wav', waveFile()));
    const second = await entity<Artifact>(await upload('b.wav', waveFile({ channels: 2 })));
    const broken = await entity<Artifact>(await upload('c.wav', Buffer.from('not audio')));
    const page = await entity<{ items: ArtifactMediaInfo[] }>(
      await mediaInfoBatch([first.id, second.id, broken.id, first.id]),
      200,
    );
    expect(page.items.map((item) => item.artifactId).sort()).toEqual([first.id, second.id].sort());
    expect(await entity(await mediaInfoBatch([]), 200)).toEqual({ items: [] });

    const atLimit = Array.from({ length: ARTIFACT_MEDIA_INFO_BATCH_LIMIT }, () => randomUUID());
    expect((await mediaInfoBatch(atLimit)).status).toBe(200);
    expect(await entity(await mediaInfoBatch([...atLimit, randomUUID()]), 422)).toMatchObject({
      code: 'invalid_request',
    });
    expect((await mediaInfoBatch(['not-a-uuid'])).status).toBe(422);
  });
});
