import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type {
  Artifact,
  ArtifactMediaInfo,
  ArtifactPreview,
  Project,
  WaveformPeaksPreview,
} from '@mmt/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ArtifactPreviewProcessor, type PreviewTools } from '../src/services/artifactPreviewProcessor.js';
import { PREVIEW_LEASE_SECONDS } from '../src/services/artifactPreviewQueue.js';
import { waveFile } from './audioFixtures.js';
import { projectFixture } from './fixtures.js';
import { createHarness, entity, request, testDatabaseUrl, type Harness } from './harness.js';

type Fixture = Awaited<ReturnType<typeof projectFixture>>;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const TOOL_TIMEOUT_MS = 60_000;

function hasMediaTools(): boolean {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    execFileSync('ffprobe', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
const mediaToolsInstalled = hasMediaTools();
const installedTools: PreviewTools = { ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe', timeoutMs: TOOL_TIMEOUT_MS };

/** Encodes test media with the local ffmpeg; the files are tiny and generated from lavfi sources. */
async function encodeFixture(directory: string, fileName: string, args: string[]): Promise<Buffer> {
  const output = path.join(directory, fileName);
  execFileSync('ffmpeg', ['-v', 'error', ...args, '-y', output], { stdio: 'ignore' });
  return readFile(output);
}

describe.skipIf(!testDatabaseUrl)('長い音声・動画のサーバー側preview（独立PostgreSQL）', () => {
  let harness: Harness;
  let fixture: Fixture;
  let workDirectory: string;
  const media: { mp3?: Buffer; mp4?: Buffer } = {};

  function processor(tools: PreviewTools = installedTools) {
    return new ArtifactPreviewProcessor({
      database: harness.database,
      stores: harness.services.artifactStores,
      tools,
      workDirectory,
    });
  }

  function upload(artifactPath: string, body: Buffer) {
    return request(harness.app, `${fixture.basePath}/artifacts?path=${encodeURIComponent(artifactPath)}`, {
      method: 'PUT',
      cookie: fixture.editor.cookie,
      binary: new Uint8Array(body),
    });
  }

  async function previews(artifactId: string, projectId = fixture.project.id, cookie = fixture.viewer.cookie) {
    return request(harness.app, `/api/projects/${projectId}/artifacts/${artifactId}/previews`, { cookie });
  }

  async function previewMap(artifactId: string): Promise<Record<string, ArtifactPreview>> {
    const page = await entity<{ items: ArtifactPreview[] }>(await previews(artifactId), 200);
    return Object.fromEntries(page.items.map((item) => [item.kind, item]));
  }

  async function content(artifactId: string) {
    return request(harness.app, `${fixture.basePath}/artifacts/${artifactId}/content`, {
      cookie: fixture.viewer.cookie,
    });
  }

  async function mediaInfo(artifactId: string): Promise<ArtifactMediaInfo> {
    return entity<ArtifactMediaInfo>(
      await request(harness.app, `${fixture.basePath}/artifacts/${artifactId}/media-info`, {
        cookie: fixture.viewer.cookie,
      }),
      200,
    );
  }

  beforeAll(async () => {
    harness = await createHarness();
    workDirectory = await mkdtemp(path.join(tmpdir(), 'mmt-preview-test-'));
    if (mediaToolsInstalled) {
      media.mp3 = await encodeFixture(workDirectory, 'tone.mp3', [
        '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=2', '-ac', '2',
      ]);
      media.mp4 = await encodeFixture(workDirectory, 'clip.mp4', [
        '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=10:duration=2', '-c:v', 'mpeg4',
      ]);
    }
  });
  beforeEach(async () => {
    await harness.reset();
    fixture = await projectFixture(harness);
  });
  afterAll(async () => {
    await harness?.close();
    if (workDirectory) await rm(workDirectory, { recursive: true, force: true });
  });

  it.skipIf(!mediaToolsInstalled)(
    'mp3をuploadするとqueuedになり、workerを1回回すとreadyで生成物を読め、media情報がffprobe由来で入る',
    async () => {
      const artifact = await entity<Artifact>(await upload('eval/long.mp3', media.mp3!));
      const queued = await previewMap(artifact.id);
      expect(Object.keys(queued).sort()).toEqual(['spectrogram', 'waveform-peaks']);
      expect(Object.values(queued).every((preview) => preview.status === 'queued')).toBe(true);

      expect(await processor().processNext()).toBe(true);
      const ready = await previewMap(artifact.id);
      expect(ready['waveform-peaks']).toMatchObject({ status: 'ready', error: null, attempts: 1 });
      expect(ready.spectrogram).toMatchObject({ status: 'ready', error: null });

      const peaksResponse = await content(ready['waveform-peaks']!.previewArtifactId!);
      expect(peaksResponse.status).toBe(200);
      const peaks = (await peaksResponse.json()) as WaveformPeaksPreview;
      expect(peaks).toMatchObject({ version: 1, sampleRate: 44100 });
      expect(peaks.min.length).toBe(peaks.max.length);
      expect(peaks.min.length).toBeGreaterThan(0);
      // A 440 Hz tone at ffmpeg's default amplitude (1/8) peaks well above silence.
      expect(Math.max(...peaks.max)).toBeGreaterThan(0.1);
      expect(peaks.durationSeconds).toBeGreaterThan(1.9);

      const image = await content(ready.spectrogram!.previewArtifactId!);
      expect(image.headers.get('Content-Type')).toContain('image/png');
      expect(Buffer.from(await image.arrayBuffer()).subarray(0, 8)).toEqual(PNG_SIGNATURE);

      expect(await mediaInfo(artifact.id)).toMatchObject({
        source: 'ffprobe',
        codec: 'mp3',
        sampleRate: 44100,
        channels: 2,
        bitsPerSample: null,
      });
      // The generated files are Artifacts of the same Project without a Run.
      const {
        rows: [stored],
      } = await harness.database.query<{ run_id: string | null; path: string; project_id: string }>(
        'SELECT run_id,path,project_id FROM artifacts WHERE id=$1',
        [ready.spectrogram!.previewArtifactId],
      );
      expect(stored).toEqual({
        run_id: null,
        path: `.previews/${artifact.id}/spectrogram.png`,
        project_id: fixture.project.id,
      });
      // Preview files are not audio or video, so they queue nothing themselves.
      expect(await processor().processNext()).toBe(false);
    },
  );

  it.skipIf(!mediaToolsInstalled)('ヘッダーから読んだWAVのmedia情報はffprobeで上書きしない', async () => {
    const artifact = await entity<Artifact>(
      await upload('eval/sample.wav', waveFile({ sampleRate: 16000, channels: 1, frames: 16000 })),
    );
    // A small WAV is analyzed in the browser, so nothing is queued for it.
    expect(await entity(await previews(artifact.id), 200)).toEqual({ items: [] });
    // Stand in for a WAV over the browser limit, which registration would queue.
    await harness.database.query(
      `INSERT INTO artifact_previews(artifact_id,project_id,kind) VALUES($1,$2,'waveform-peaks')`,
      [artifact.id, fixture.project.id],
    );
    const { rows: before } = await harness.database.query(
      'SELECT created_at FROM artifact_media_info WHERE artifact_id=$1',
      [artifact.id],
    );
    expect(await processor().processNext()).toBe(true);
    expect((await previewMap(artifact.id))['waveform-peaks']!.status).toBe('ready');
    expect(await mediaInfo(artifact.id)).toMatchObject({ source: 'header', codec: 'pcm_s16le', durationSeconds: 1 });
    const { rows: after } = await harness.database.query(
      'SELECT created_at FROM artifact_media_info WHERE artifact_id=$1',
      [artifact.id],
    );
    expect(after).toEqual(before);
  });

  it.skipIf(!mediaToolsInstalled)('壊れたファイルはfailedになり、本体のcontentは読める', async () => {
    const broken = Buffer.from('ID3 this is not an mp3 stream at all'.repeat(32));
    const artifact = await entity<Artifact>(await upload('eval/broken.mp3', broken));
    expect(await processor().processNext()).toBe(true);
    const failed = await previewMap(artifact.id);
    expect(failed['waveform-peaks']).toMatchObject({ status: 'failed', error: 'probe_failed', previewArtifactId: null });
    expect(failed.spectrogram).toMatchObject({ status: 'failed', error: 'probe_failed' });
    const response = await content(artifact.id);
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(broken);
    // A deterministic failure is not retried.
    expect(await processor().processNext()).toBe(false);
  });

  it.skipIf(!mediaToolsInstalled)('動画はposterを作り、音声streamの無い動画にはmedia情報を作らない', async () => {
    const artifact = await entity<Artifact>(await upload('clips/sample.mp4', media.mp4!));
    expect(Object.keys(await previewMap(artifact.id))).toEqual(['video-poster']);
    expect(await processor().processNext()).toBe(true);
    const poster = (await previewMap(artifact.id))['video-poster']!;
    expect(poster.status).toBe('ready');
    const image = await content(poster.previewArtifactId!);
    expect(Buffer.from(await image.arrayBuffer()).subarray(0, 8)).toEqual(PNG_SIGNATURE);
    const missing = await request(harness.app, `${fixture.basePath}/artifacts/${artifact.id}/media-info`, {
      cookie: fixture.viewer.cookie,
    });
    expect(missing.status).toBe(404);
  });

  it('ffmpegが無い環境ではskippedになる', async () => {
    const artifact = await entity<Artifact>(await upload('eval/a.mp3', Buffer.from('not decoded here')));
    const missingTools = { ffmpegPath: '/nonexistent/ffmpeg', ffprobePath: '/nonexistent/ffprobe', timeoutMs: 1000 };
    expect(await processor(missingTools).processNext()).toBe(true);
    const skipped = await previewMap(artifact.id);
    expect(skipped['waveform-peaks']).toMatchObject({ status: 'skipped', error: 'ffmpeg_unavailable' });
    expect(skipped.spectrogram).toMatchObject({ status: 'skipped', error: 'ffmpeg_unavailable' });
    expect((await content(artifact.id)).status).toBe(200);
  });

  it('保存先から本体を読めなければqueuedへ戻し、上限回数で諦める', async () => {
    const artifact = await entity<Artifact>(await upload('eval/a.mp3', Buffer.from('bytes')));
    const failingRead = new ArtifactPreviewProcessor({
      database: harness.database,
      stores: { ...harness.stores, read: () => Promise.reject(new Error('storage down')) },
      tools: installedTools,
      workDirectory,
    });
    expect(await failingRead.processNext()).toBe(true);
    expect((await previewMap(artifact.id))['waveform-peaks']).toMatchObject({
      status: 'queued',
      error: 'source_unreadable',
      attempts: 1,
    });
    expect(await failingRead.processNext()).toBe(true);
    expect(await failingRead.processNext()).toBe(true);
    expect((await previewMap(artifact.id))['waveform-peaks']).toMatchObject({ status: 'failed', attempts: 3 });
    expect(await failingRead.processNext()).toBe(false);
  });

  it('期限切れのrunningは別のworkerが引き継ぎ、古いworkerの結果は捨てる', async () => {
    const artifact = await entity<Artifact>(await upload('eval/a.mp3', Buffer.from('bytes')));
    await harness.database.query(
      `UPDATE artifact_previews SET status='running',attempts=1,
         updated_at=now() - make_interval(secs => $2 + 60) WHERE artifact_id=$1`,
      [artifact.id, PREVIEW_LEASE_SECONDS],
    );
    const missingTools = { ffmpegPath: '/nonexistent/ffmpeg', ffprobePath: '/nonexistent/ffprobe', timeoutMs: 1000 };
    expect(await processor(missingTools).processNext()).toBe(true);
    expect((await previewMap(artifact.id))['waveform-peaks']).toMatchObject({ status: 'skipped', attempts: 2 });
  });

  it('他Projectのpreviewは読めず、Projectに属さないユーザーは参照できない', async () => {
    const artifact = await entity<Artifact>(await upload('eval/a.mp3', Buffer.from('bytes')));
    const other = await entity<Project>(
      await request(harness.app, '/api/projects', {
        method: 'POST',
        cookie: fixture.administrator.cookie,
        body: { name: 'Other Project' },
      }),
    );
    expect(await entity(await previews(artifact.id, other.id, fixture.administrator.cookie), 404)).toMatchObject({
      code: 'not_found',
    });
    expect((await previews(artifact.id, fixture.project.id, fixture.outsider.cookie)).status).toBe(403);
    expect((await previews('not-a-uuid')).status).toBe(422);
  });
});
