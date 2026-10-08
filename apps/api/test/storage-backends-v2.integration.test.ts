import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Artifact, Project, StorageBackend, StorageTestResult } from '@mmt/contracts';
import {
  createArtifactStoreFromConfig,
  normalizeStorageBackendConfig,
  type ArtifactStore,
  type StorageBackendConfigInput,
} from '@mmt/platform';
// Test-only oracle: the proxy recomputes each signature from the bytes that reached it.
import { signatureV2Authorization } from '../../../packages/platform/src/s3SignatureV2.js';
import { createApplication } from '../src/app.js';
import { parseSecretKey } from '../src/security/secretEncryption.js';
import { createHarness, entity, login, request, testDatabaseUrl, type Harness } from './harness.js';

const s3Endpoint = process.env.MMT_TEST_S3_ENDPOINT;
// When set, the observed requests (method, subresources, Authorization scheme) are written here.
const recordPath = process.env.MMT_TEST_S3_V2_RECORD;
// These values authenticate only to the isolated emulator, never to real storage. The SDK adds
// attribution fields to a credentials object it is given, so every caller gets its own copy.
const credentials = () => ({ accessKeyId: 'testing', secretAccessKey: 'testing' });
const MIB = 1024 * 1024;
// S3 requires every part but the last to be at least 5 MiB.
const PART_SIZE = 5 * MIB;
// Moto takes several seconds per multi-MiB part on a loaded machine.
const MULTIPART_TEST_TIMEOUT_MS = 120_000;

interface ObservedRequest {
  method: string;
  path: string;
  query: string[];
  authorizationScheme: string;
  signatureMatches: boolean;
  v4OnlyHeaders: string[];
}

function decodedQuery(search: URLSearchParams): Record<string, string> {
  return Object.fromEntries(search.entries());
}

/**
 * Forwards to the emulator and records what each request carried. Moto does not check signatures,
 * so the proxy recomputes the v2 signature from the received method, path, query and headers.
 */
function startRecordingProxy(target: URL, observed: ObservedRequest[]): Promise<http.Server> {
  const server = http.createServer((incoming, outgoing) => {
    const url = new URL(incoming.url ?? '/', 'http://proxy.invalid');
    const headers = Object.fromEntries(
      Object.entries(incoming.headers).map(([name, value]) => [
        name,
        Array.isArray(value) ? value.join(',') : (value ?? ''),
      ]),
    );
    const expected = signatureV2Authorization({
      request: {
        method: incoming.method ?? 'GET',
        hostname: url.hostname,
        path: url.pathname,
        query: decodedQuery(url.searchParams),
        headers,
      },
      credentials: credentials(),
    });
    observed.push({
      method: incoming.method ?? '',
      path: url.pathname,
      query: [...url.searchParams.keys()].filter((name) => name !== 'x-id').sort(),
      authorizationScheme: (headers.authorization ?? '').split(' ')[0] ?? '',
      signatureMatches: headers.authorization === expected,
      v4OnlyHeaders: Object.keys(headers).filter((name) =>
        /^x-amz-(checksum-|sdk-checksum|content-sha256|decoded-content-length|trailer)/.test(name),
      ),
    });
    const forwarded = http.request(
      {
        host: target.hostname,
        port: target.port,
        method: incoming.method,
        path: incoming.url,
        headers: incoming.headers,
      },
      (response) => {
        outgoing.writeHead(response.statusCode ?? 502, response.headers);
        response.pipe(outgoing);
      },
    );
    forwarded.on('error', () => outgoing.destroy());
    incoming.pipe(forwarded);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function contents(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks);
}

describe.skipIf(!testDatabaseUrl || !s3Endpoint)('署名v2のS3保存先（独立PostgreSQLとMoto）', () => {
  const bucket = `mmt-v2-${randomUUID()}`;
  const observed: ObservedRequest[] = [];
  let proxy: http.Server;
  let proxyEndpoint: string;
  let harness: Harness;
  let app: ReturnType<typeof createApplication>;
  let admin: { cookie: string; userId: string };

  function v2Store(overrides: Partial<StorageBackendConfigInput> = {}): ArtifactStore {
    const config = normalizeStorageBackendConfig({
      kind: 's3',
      endpoint: proxyEndpoint,
      bucket,
      prefix: 'mmt',
      pathStyle: true,
      signatureVersion: 'v2',
      multipartPartSizeBytes: PART_SIZE,
      ...overrides,
    });
    return createArtifactStoreFromConfig({ config, credentials: credentials() });
  }
  function call(endpoint: string, options: Parameters<typeof request>[2] = {}): Promise<Response> {
    return request(app.app, endpoint, { cookie: admin.cookie, ...options });
  }
  async function createV2Backend(name: string, extra: Record<string, unknown> = {}) {
    return entity<StorageBackend>(
      await call('/api/admin/storage-backends', {
        method: 'POST',
        body: {
          name,
          kind: 's3',
          endpoint: proxyEndpoint,
          bucket,
          prefix: name,
          pathStyle: true,
          signatureVersion: 'v2',
          ...credentials(),
          ...extra,
        },
      }),
    );
  }
  async function createProject(artifactBackend: string): Promise<Project> {
    return entity<Project>(
      await call('/api/projects', {
        method: 'POST',
        body: { name: `Project ${randomUUID()}`, artifactBackend },
      }),
    );
  }

  beforeAll(async () => {
    const setup = new S3Client({
      endpoint: s3Endpoint,
      region: 'us-east-1',
      forcePathStyle: true,
      credentials: credentials(),
    });
    await setup.send(new CreateBucketCommand({ Bucket: bucket }));
    setup.destroy();
    proxy = await startRecordingProxy(new URL(s3Endpoint!), observed);
    proxyEndpoint = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
    harness = await createHarness();
    app = createApplication({
      config: {
        ...harness.config,
        storageSecretKey: parseSecretKey(randomBytes(32).toString('base64')),
      },
      database: harness.database,
      stores: harness.stores,
    });
  });
  beforeEach(async () => {
    await harness.reset();
    await app.services.artifactStores.reload();
    admin = await login(harness);
  });
  afterAll(async () => {
    await harness?.close();
    await new Promise((resolve) => proxy?.close(resolve));
    for (const request of observed) {
      expect(request.authorizationScheme, `${request.method} ${request.path}`).toBe('AWS');
      expect(request.signatureMatches, `${request.method} ${request.path}`).toBe(true);
      expect(request.v4OnlyHeaders).toEqual([]);
    }
    if (recordPath) await writeFile(recordPath, `${JSON.stringify(observed, null, 2)}\n`);
  });

  it('v2の保存先を作ると接続テストが通り、Artifactを保存・Range付きで読める', async () => {
    const backend = await createV2Backend('legacy');
    expect(backend).toMatchObject({ signatureVersion: 'v2', multipartEnabled: true });
    const tested = await entity<StorageTestResult>(
      await call('/api/admin/storage-backends/legacy/test', { method: 'POST' }),
      200,
    );
    expect(tested.steps).toEqual([
      { name: 'put', ok: true },
      { name: 'get', ok: true },
      { name: 'range', ok: true },
      { name: 'delete', ok: true },
    ]);
    const project = await createProject('legacy');
    const artifact = await entity<Artifact>(
      await call(`/api/projects/${project.id}/artifacts?path=audio/a.wav`, {
        method: 'PUT',
        binary: 'signed with v2',
        headers: { 'Content-Type': 'application/octet-stream' },
      }),
    );
    expect(artifact.backend).toBe('legacy');
    const ranged = await call(`/api/projects/${project.id}/artifacts/${artifact.id}/content`, {
      headers: { Range: 'bytes=12-13' },
    });
    expect(ranged.status).toBe(206);
    expect(await ranged.text()).toBe('v2');
  });

  it(
    'v2で単一putのmultipart分割、range、deleteができる',
    async () => {
      const store = v2Store();
      const bytes = randomBytes(12 * MIB);
      const written = await store.put({
        key: 'p/a/weights',
        body: Readable.from([bytes.subarray(0, 7 * MIB), bytes.subarray(7 * MIB)]),
        mimeType: 'application/octet-stream',
      });
      expect(written).toEqual({
        size: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      });
      const ranged = await store.read({ key: 'p/a/weights', range: 'bytes=5242879-5242880' });
      expect(ranged.status).toBe(206);
      expect(await contents(ranged.body)).toEqual(bytes.subarray(PART_SIZE - 1, PART_SIZE + 1));
      await store.remove('p/a/weights');
      await expect(store.read({ key: 'p/a/weights' })).rejects.toMatchObject({
        name: 'ArtifactNotFoundError',
      });
      const uploads = observed.filter((entry) => entry.path.endsWith('/p/a/weights'));
      expect(uploads.map((entry) => [entry.method, entry.query.join('&')])).toEqual(
        expect.arrayContaining([
          ['POST', 'uploads'],
          ['PUT', 'partNumber&uploadId'],
          ['POST', 'uploadId'],
          ['DELETE', ''],
        ]),
      );
    },
    MULTIPART_TEST_TIMEOUT_MS,
  );

  it(
    'v2でupload sessionのmultipart（作成・part・一覧・完了・中止）を署名できる',
    async () => {
      const multipart = v2Store().multipart!;
      const first = randomBytes(PART_SIZE);
      const last = randomBytes(1024);
      const created = await multipart.createMultipart({ key: 'p/b/audio', mimeType: 'audio/wav' });
      const parts = [];
      for (const [index, body] of [first, last].entries())
        parts.push({
          partNumber: index + 1,
          ...(await multipart.putPart({
            key: 'p/b/audio',
            ...created,
            partNumber: index + 1,
            body: Readable.from([body]),
            size: body.length,
          })),
        });
      const listed = await multipart.listIncompleteUploads();
      expect(listed.map((upload) => upload.backendUploadId)).toContain(created.backendUploadId);
      await multipart.completeMultipart({ key: 'p/b/audio', ...created, parts });
      const read = await v2Store().read({ key: 'p/b/audio' });
      expect(await contents(read.body)).toEqual(Buffer.concat([first, last]));

      const abandoned = await multipart.createMultipart({
        key: 'p/c/audio',
        mimeType: 'audio/wav',
      });
      await multipart.abortMultipart({ key: 'p/c/audio', ...abandoned });
      expect(
        (await multipart.listIncompleteUploads()).map((upload) => upload.backendUploadId),
      ).not.toContain(abandoned.backendUploadId);
      const aborted = observed.find(
        (entry) => entry.method === 'DELETE' && entry.path.endsWith('/p/c/audio'),
      );
      expect(aborted?.query).toEqual(['uploadId']);
    },
    MULTIPART_TEST_TIMEOUT_MS,
  );

  it(
    'multipartを無効にした保存先は1回のPUTで保存し、upload sessionを422で断る',
    async () => {
      const backend = await createV2Backend('single-put', { multipartEnabled: false });
      expect(backend.multipartEnabled).toBe(false);
      const store = v2Store({ prefix: 'single-put', multipartEnabled: false });
      const bytes = randomBytes(6 * MIB);
      await store.put({
        key: 'p/d/large',
        body: Readable.from([bytes.subarray(0, 3 * MIB), bytes.subarray(3 * MIB)]),
        mimeType: 'application/octet-stream',
      });
      const sent = observed.filter((entry) => entry.path.endsWith('/p/d/large'));
      expect(sent.map((entry) => [entry.method, entry.query.join('&')])).toEqual([['PUT', '']]);
      expect(await contents((await store.read({ key: 'p/d/large' })).body)).toEqual(bytes);

      const project = await createProject('single-put');
      const refused = await call(`/api/projects/${project.id}/artifact-uploads`, {
        method: 'POST',
        body: { path: 'audio/long.wav', expectedSize: 6 * MIB, partSize: PART_SIZE },
      });
      expect(refused.status).toBe(422);
      expect(((await refused.json()) as { code: string }).code).toBe('multipart_unsupported');
    },
    MULTIPART_TEST_TIMEOUT_MS,
  );
});
