import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Artifact } from '@mmt/contracts';
import { artifactFixture, transferUrl } from './mlflow-artifacts-fixtures.js';
import { createHarness, entity, request, testDatabaseUrl, type Harness } from './harness.js';

const AUDIO_BYTES = Buffer.from('0123456789abcdef');

describe.skipIf(!testDatabaseUrl)('Artifact content配信（独立PostgreSQL）', () => {
  let harness: Harness;
  let fixture: Awaited<ReturnType<typeof artifactFixture>>;

  async function upload(path: string, options: { mimeType?: string; body?: Buffer } = {}) {
    return entity<Artifact>(
      await request(harness.app, `${fixture.basePath}/artifacts?path=${encodeURIComponent(path)}`, {
        method: 'PUT',
        cookie: fixture.editor.cookie,
        // A Uint8Array body keeps fetch from adding its own text/plain Content-Type.
        binary: new Uint8Array(options.body ?? AUDIO_BYTES),
        headers: options.mimeType ? { 'Content-Type': options.mimeType } : {},
      }),
    );
  }

  function content(artifact: Artifact, headers: Record<string, string> = {}) {
    return request(harness.app, `${fixture.basePath}/artifacts/${artifact.id}/content`, {
      cookie: fixture.viewer.cookie,
      headers,
    });
  }

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

  it('不変なArtifactにsha256のETagとimmutableなCache-Controlを付ける', async () => {
    const artifact = await upload('audio/x.wav', { mimeType: 'audio/wav' });
    const response = await content(artifact);
    expect(response.status).toBe(200);
    expect(response.headers.get('ETag')).toBe(`"sha256-${artifact.sha256}"`);
    expect(response.headers.get('Cache-Control')).toBe('private, max-age=31536000, immutable');
    expect(response.headers.get('Accept-Ranges')).toBe('bytes');
    expect(response.headers.get('Content-Disposition')).toBe("inline; filename*=UTF-8''x.wav");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(AUDIO_BYTES);
  });

  it('If-None-Matchが一致すれば本文なしの304を返す', async () => {
    const artifact = await upload('audio/x.wav', { mimeType: 'audio/wav' });
    const entityTag = `"sha256-${artifact.sha256}"`;
    const response = await content(artifact, { 'If-None-Match': `"other", W/${entityTag}` });
    expect(response.status).toBe(304);
    expect(response.headers.get('ETag')).toBe(entityTag);
    expect(response.headers.get('Cache-Control')).toBe('private, max-age=31536000, immutable');
    expect(await response.text()).toBe('');
    expect((await content(artifact, { 'If-None-Match': '"sha256-0"' })).status).toBe(200);
  });

  it('Rangeは206とContent-Rangeを返し、If-Rangeが一致しなければ全体を200で返す', async () => {
    const artifact = await upload('audio/x.wav', { mimeType: 'audio/wav' });
    const entityTag = `"sha256-${artifact.sha256}"`;
    const partial = await content(artifact, { Range: 'bytes=2-5' });
    expect(partial.status).toBe(206);
    expect(partial.headers.get('Content-Range')).toBe(`bytes 2-5/${AUDIO_BYTES.length}`);
    expect(partial.headers.get('ETag')).toBe(entityTag);
    expect(await partial.text()).toBe('2345');

    const matching = await content(artifact, { Range: 'bytes=2-5', 'If-Range': entityTag });
    expect(matching.status).toBe(206);
    expect(await matching.text()).toBe('2345');

    const stale = await content(artifact, { Range: 'bytes=2-5', 'If-Range': '"sha256-stale"' });
    expect(stale.status).toBe(200);
    expect(stale.headers.get('Content-Range')).toBeNull();
    expect(Buffer.from(await stale.arrayBuffer())).toEqual(AUDIO_BYTES);
  });

  it('HTMLとSVGは宣言どおりのMIMEでもattachmentとsandboxで返す', async () => {
    for (const [path, mimeType] of [
      ['report.html', 'text/html'],
      ['figure.svg', 'image/svg+xml'],
    ] as const) {
      const artifact = await upload(path, { mimeType, body: Buffer.from('<script>1</script>') });
      const response = await content(artifact);
      expect(response.headers.get('Content-Disposition')).toMatch(/^attachment;/);
      expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
      expect(response.headers.get('Content-Security-Policy')).toBe("sandbox; default-src 'none'");
    }
  });

  it('octet-streamやContent-Type無しで送ったx.flacは拡張子からaudio/flacにしてinlineで返す', async () => {
    const declaredOctetStream = await upload('x.flac', { mimeType: 'application/octet-stream' });
    const undeclared = await upload('voice/y.FLAC');
    expect(declaredOctetStream.mimeType).toBe('audio/flac');
    expect(undeclared.mimeType).toBe('audio/flac');
    const response = await content(declaredOctetStream);
    expect(response.headers.get('Content-Type')).toBe('audio/flac');
    expect(response.headers.get('Content-Disposition')).toMatch(/^inline;/);
  });

  it('octet-streamで送ったx.htmlはHTMLと推定せずattachmentで返す', async () => {
    const artifact = await upload('x.html', { mimeType: 'application/octet-stream' });
    expect(artifact.mimeType).toBe('application/octet-stream');
    const response = await content(artifact);
    expect(response.headers.get('Content-Disposition')).toMatch(/^attachment;/);
  });

  it('クライアントが具体的なMIMEを宣言したときは拡張子より宣言を優先する', async () => {
    const artifact = await upload('labels.csv', { mimeType: 'text/plain' });
    expect(artifact.mimeType).toBe('text/plain');
  });

  it('MLflow経路は同じETagを返すがpathの付け替えに備えてno-storeのままにする', async () => {
    const put = await request(
      fixture.app,
      transferUrl(fixture.mlflowPath, fixture.runRoot, 'a.wav'),
      {
        method: 'PUT',
        cookie: fixture.editor.cookie,
        binary: new Uint8Array(AUDIO_BYTES),
      },
    );
    expect(put.status).toBe(200);
    const stored = await harness.database.query<{ sha256: string; mime_type: string }>(
      'SELECT sha256,mime_type FROM artifacts',
    );
    expect(stored.rows[0]!.mime_type).toBe('audio/wav');
    const response = await request(
      fixture.app,
      transferUrl(fixture.mlflowPath, fixture.runRoot, 'a.wav'),
      { cookie: fixture.viewer.cookie },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('ETag')).toBe(`"sha256-${stored.rows[0]!.sha256}"`);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('Content-Disposition')).toMatch(/^attachment;/);
  });
});
