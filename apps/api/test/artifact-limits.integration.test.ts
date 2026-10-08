import { readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ArtifactStores } from '@mmt/platform';
import { createApplication } from '../src/app.js';
import { serverTimeouts } from '../src/http/serverTimeouts.js';
import { ArtifactSizeLimit } from '../src/services/artifactSizeLimit.js';
import { DomainError } from '../src/domain/errors.js';
import { artifactFixture, transferUrl } from './mlflow-artifacts-fixtures.js';
import { createHarness, testDatabaseUrl, type Harness } from './harness.js';

// Small enough that a few short strings cross it, so tests stay fast.
const TEST_MAX_BYTES = 16;

async function drain(source: Readable, limit: ArtifactSizeLimit): Promise<Buffer> {
  const chunks: Buffer[] = [];
  await pipeline(source, limit, async (stream: AsyncIterable<Buffer>) => {
    for await (const chunk of stream) chunks.push(chunk);
  });
  return Buffer.concat(chunks);
}

describe('ArtifactSizeLimit', () => {
  it('上限ちょうどのbytesはそのまま通す', async () => {
    const bytes = Buffer.alloc(TEST_MAX_BYTES, 1);
    expect(await drain(Readable.from([bytes]), new ArtifactSizeLimit(TEST_MAX_BYTES))).toEqual(
      bytes,
    );
  });

  it('上限+1byteで413 artifact_too_largeとして失敗する', async () => {
    const limit = new ArtifactSizeLimit(TEST_MAX_BYTES);
    const chunks = [Buffer.alloc(TEST_MAX_BYTES - 1), Buffer.alloc(2)];
    const failure = await drain(Readable.from(chunks), limit).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(DomainError);
    expect(failure).toMatchObject({ status: 413, code: 'artifact_too_large' });
    expect(limit.isExceeded).toBe(true);
  });
});

describe('serverTimeouts', () => {
  it('request全体のtimeoutと無通信timeoutを環境変数の値から反映する', () => {
    expect(serverTimeouts({ uploadRequestTimeoutMs: 0, uploadIdleTimeoutMs: 120_000 })).toEqual({
      serverOptions: { requestTimeout: 0, headersTimeout: 60_000 },
      idleTimeoutMs: 120_000,
    });
    expect(
      serverTimeouts({ uploadRequestTimeoutMs: 3_600_000, uploadIdleTimeoutMs: 30_000 }),
    ).toEqual({
      serverOptions: { requestTimeout: 3_600_000, headersTimeout: 60_000 },
      idleTimeoutMs: 30_000,
    });
  });

  it('request全体のtimeoutがheader受信の60秒より短いときはheader側を縮める', () => {
    expect(
      serverTimeouts({ uploadRequestTimeoutMs: 10_000, uploadIdleTimeoutMs: 5_000 }).serverOptions,
    ).toEqual({ requestTimeout: 10_000, headersTimeout: 10_000 });
  });
});

describe.skipIf(!testDatabaseUrl)('Artifactのサイズ上限（独立PostgreSQL）', () => {
  let harness: Harness;
  let storedWrites: number;

  function limitedApplication() {
    const stores: ArtifactStores = {
      ...harness.stores,
      async put(write) {
        storedWrites += 1;
        return harness.stores.put(write);
      },
    };
    return createApplication({
      config: { ...harness.config, artifactMaxBytes: TEST_MAX_BYTES },
      database: harness.database,
      stores,
    }).app;
  }

  async function remainingBlobs(): Promise<string[]> {
    const entries = await readdir(harness.artifactDirectory, {
      recursive: true,
      withFileTypes: true,
    });
    return entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
  }

  async function artifactRowCount(): Promise<number> {
    const result = await harness.database.query<{ count: string }>(
      'SELECT count(*) FROM artifacts',
    );
    return Number(result.rows[0]!.count);
  }

  function chunkedBody(chunks: string[]): ReadableStream<Uint8Array> {
    return Readable.toWeb(
      Readable.from(chunks.map((chunk) => Buffer.from(chunk))),
    ) as ReadableStream<Uint8Array>;
  }

  beforeAll(async () => {
    harness = await createHarness();
  });
  beforeEach(async () => {
    await harness.reset();
    // reset() clears only the database; earlier uploads would otherwise look like leftovers.
    for (const entry of await readdir(harness.artifactDirectory))
      await rm(path.join(harness.artifactDirectory, entry), { recursive: true, force: true });
    storedWrites = 0;
  });
  afterAll(async () => {
    await harness?.close();
  });

  it('Content-Lengthが上限を超えるnative uploadは保存を始めずに413を返し、blobもDB行も残さない', async () => {
    const fixture = await artifactFixture(harness);
    const response = await limitedApplication().request(
      `${fixture.basePath}/runs/${fixture.run.id}/artifacts?path=big.bin`,
      {
        method: 'PUT',
        headers: {
          Origin: 'http://127.0.0.1:5182',
          Cookie: fixture.editor.cookie,
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(TEST_MAX_BYTES + 1),
        },
        body: 'x'.repeat(TEST_MAX_BYTES + 1),
      },
    );
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ code: 'artifact_too_large' });
    expect(storedWrites).toBe(0);
    expect(await remainingBlobs()).toEqual([]);
    expect(await artifactRowCount()).toBe(0);
  });

  it('Content-Lengthの無いchunk転送が途中で上限を超えたら中断し、書きかけのblobを消す', async () => {
    const fixture = await artifactFixture(harness);
    const response = await limitedApplication().request(
      `${fixture.basePath}/artifacts?path=stream.bin`,
      {
        method: 'PUT',
        headers: {
          Origin: 'http://127.0.0.1:5182',
          Cookie: fixture.editor.cookie,
          'Content-Type': 'application/octet-stream',
        },
        body: chunkedBody(['0123456789', '0123456789']),
        duplex: 'half',
      } as RequestInit,
    );
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ code: 'artifact_too_large' });
    expect(storedWrites).toBe(1);
    expect(await remainingBlobs()).toEqual([]);
    expect(await artifactRowCount()).toBe(0);
  });

  it('上限以内のchunk転送は保存できる', async () => {
    const fixture = await artifactFixture(harness);
    const response = await limitedApplication().request(
      `${fixture.basePath}/artifacts?path=ok.bin`,
      {
        method: 'PUT',
        headers: { Origin: 'http://127.0.0.1:5182', Cookie: fixture.editor.cookie },
        body: chunkedBody(['01234567', '89abcdef']),
        duplex: 'half',
      } as RequestInit,
    );
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ size: TEST_MAX_BYTES });
  });

  it('MLflow PUTも同じ上限を通り、MLflow形式のRESOURCE_EXHAUSTEDを413で返す', async () => {
    const fixture = await artifactFixture(harness);
    const response = await limitedApplication().request(
      transferUrl(fixture.mlflowPath, fixture.runRoot, 'weights.bin'),
      {
        method: 'PUT',
        headers: { Origin: 'http://127.0.0.1:5182', Cookie: fixture.editor.cookie },
        body: chunkedBody(['0123456789', '0123456789']),
        duplex: 'half',
      } as RequestInit,
    );
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({
      error_code: 'RESOURCE_EXHAUSTED',
      message: expect.stringContaining('上限'),
    });
    expect(await remainingBlobs()).toEqual([]);
    expect(await artifactRowCount()).toBe(0);
    const mappings = await harness.database.query('SELECT 1 FROM mlflow_artifact_paths');
    expect(mappings.rowCount).toBe(0);
  });
});
