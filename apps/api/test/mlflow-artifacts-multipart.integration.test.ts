import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectCommand,
  ListMultipartUploadsCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';
import {
  createArtifactStores,
  createFilesystemArtifactStore,
  createS3ArtifactStore,
  MULTIPART_MIN_PART_BYTES,
} from '@mmt/platform';
import type { Job, WorkerJob } from '@mmt/contracts';
import type { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApplication } from '../src/app.js';
import type { ApiEnvironment } from '../src/http/request.js';
import { executionFixture } from './fixtures.js';
import { artifactFixture, transferUrl } from './mlflow-artifacts-fixtures.js';
import { createHarness, entity, request, testDatabaseUrl, type Harness } from './harness.js';

// Copied from mlflow.exceptions._UnsupportedMultipartUploadException.MESSAGE on purpose: the SDK
// falls back to a plain PUT only when the message starts with this exact text.
const SDK_FALLBACK_MESSAGE =
  'Multipart upload is not supported for the current artifact repository';
const PART_TOKEN_HEADER = 'X-MMT-Upload-Token';
// One full part and a short final part, as the SDK splits a file just over one chunk.
const CONTENT = Buffer.concat([Buffer.alloc(MULTIPART_MIN_PART_BYTES, 'w'), Buffer.from('tail')]);

function partBytes(partNumber: number): Buffer {
  return CONTENT.subarray(
    (partNumber - 1) * MULTIPART_MIN_PART_BYTES,
    partNumber * MULTIPART_MIN_PART_BYTES,
  );
}

interface CreateResponse {
  upload_id: string;
  credentials: { url: string; part_number: number; headers: Record<string, string> }[];
}

describe.skipIf(!testDatabaseUrl)('MLflow multipart upload（独立PostgreSQL）', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await createHarness();
  });
  beforeEach(async () => {
    await harness.reset();
  });
  afterAll(async () => {
    await harness?.close();
  });

  type Fixture = Awaited<ReturnType<typeof artifactFixture>>;

  function mpuUrl(fixture: Fixture, action: string, ownerRoot: string, directory = '') {
    return `${fixture.mlflowPath}/api/2.0/mlflow-artifacts/mpu/${action}/${ownerRoot}${directory ? `/${directory}` : ''}`;
  }

  async function createMultipart(
    fixture: Fixture,
    options: {
      ownerRoot?: string;
      directory?: string;
      numParts?: number;
      localPath?: string;
      app?: Hono<ApiEnvironment>;
    } = {},
  ) {
    return request(
      options.app ?? harness.app,
      mpuUrl(
        fixture,
        'create',
        options.ownerRoot ?? fixture.runRoot,
        options.directory ?? 'weights',
      ),
      {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: {
          path: options.localPath ?? '/home/trainer/out/model.bin',
          num_parts: options.numParts ?? 2,
        },
      },
    );
  }

  /** Sends a part the way MLflow's _upload_part does: the credential headers only, no cookie. */
  function putPart(
    credential: CreateResponse['credentials'][number],
    body: Buffer,
    options: { headers?: Record<string, string>; app?: Hono<ApiEnvironment> } = {},
  ) {
    const url = new URL(credential.url);
    return (options.app ?? harness.app).request(`${url.pathname}${url.search}`, {
      method: 'PUT',
      // requests sets Content-Length for bytes bodies; Request in the test does not.
      headers: {
        ...(options.headers ?? credential.headers),
        'Content-Length': String(body.length),
      },
      body: new Uint8Array(body),
    });
  }

  async function putAllParts(created: CreateResponse, app?: Hono<ApiEnvironment>) {
    const etags: string[] = [];
    for (const credential of created.credentials) {
      const response = await putPart(credential, partBytes(credential.part_number), { app });
      expect(response.status).toBe(200);
      etags.push(response.headers.get('ETag')!);
    }
    return etags;
  }

  /** Runs the finalizer while complete waits for it, as the background loop does in the server. */
  async function completeWhileFinalizing(
    complete: Promise<Response>,
    finalizer = harness.artifactUploadFinalizer,
  ): Promise<Response> {
    let settled = false;
    void complete.finally(() => (settled = true));
    while (!settled) {
      await finalizer.finalizeBatch();
      await delay(20);
    }
    return complete;
  }

  function completeMultipart(
    fixture: Fixture,
    created: CreateResponse,
    etags: string[],
    options: {
      ownerRoot?: string;
      directory?: string;
      localPath?: string;
      app?: Hono<ApiEnvironment>;
    } = {},
  ) {
    return request(
      options.app ?? harness.app,
      mpuUrl(
        fixture,
        'complete',
        options.ownerRoot ?? fixture.runRoot,
        options.directory ?? 'weights',
      ),
      {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: {
          path: options.localPath ?? '/home/trainer/out/model.bin',
          upload_id: created.upload_id,
          parts: etags.map((etag, index) => ({ part_number: index + 1, etag, url: null })),
        },
      },
    );
  }

  async function partFiles(): Promise<string[]> {
    const entries = await readdir(harness.artifactDirectory, {
      recursive: true,
      withFileTypes: true,
    });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.part'))
      .map((entry) => entry.name);
  }

  it('server-infoは/server-infoと/api/3.0/mlflow/server-infoの両方でmultipart uploadを有効と返す', async () => {
    const fixture = await artifactFixture(harness);
    for (const path of ['/server-info', '/api/3.0/mlflow/server-info']) {
      const response = await request(harness.app, `${fixture.mlflowPath}${path}`, {
        cookie: fixture.viewer.cookie,
      });
      expect(response.status, path).toBe(200);
      expect(await response.json()).toEqual({
        mlflow_compatibility: '3',
        multipart_uploads_enabled: true,
        multipart_downloads_enabled: false,
      });
      expect((await request(harness.app, `${fixture.mlflowPath}${path}`)).status).toBe(401);
    }
  });

  it('create→part PUT→completeでRunのArtifactができ、一覧とGETのbytesが一致する', async () => {
    const fixture = await artifactFixture(harness);
    const created = await entity<CreateResponse>(await createMultipart(fixture), 200);
    expect(created.credentials.map((credential) => credential.part_number)).toEqual([1, 2]);
    const [first, second] = created.credentials as [
      CreateResponse['credentials'][number],
      CreateResponse['credentials'][number],
    ];
    expect(first.url).toBe(
      `http://localhost${fixture.mlflowPath}/api/2.0/mlflow-artifacts/mpu/parts/${created.upload_id}/1`,
    );

    const withoutToken = await putPart(first, partBytes(1), { headers: {} });
    expect(withoutToken.status).toBe(401);
    expect(((await withoutToken.json()) as { error_code: string }).error_code).toBe(
      'UNAUTHENTICATED',
    );
    const other = await entity<CreateResponse>(
      await createMultipart(fixture, { directory: 'other' }),
      200,
    );
    const foreignToken = await putPart(first, partBytes(1), {
      headers: other.credentials[0]!.headers,
    });
    expect(foreignToken.status).toBe(403);
    expect(await partFiles()).toEqual([]);

    const etags = await putAllParts(created);
    expect(etags[1]).toBe(`"${createHash('sha256').update(partBytes(2)).digest('hex')}"`);
    // A session is reachable only through the protocol that opened it.
    const native = await request(
      harness.app,
      `${fixture.basePath}/artifact-uploads/${created.upload_id}`,
      {
        cookie: fixture.editor.cookie,
      },
    );
    expect(native.status).toBe(404);

    const completed = await completeWhileFinalizing(completeMultipart(fixture, created, etags));
    expect(completed.status).toBe(200);
    expect(await completed.json()).toEqual({});

    const listing = await request(
      harness.app,
      `${fixture.mlflowPath}/api/2.0/mlflow/artifacts/list?run_id=${fixture.run.id}&path=weights`,
      { cookie: fixture.viewer.cookie },
    );
    expect(((await listing.json()) as { files: unknown[] }).files).toEqual([
      { path: 'weights/model.bin', is_dir: false, file_size: String(CONTENT.length) },
    ]);
    const download = await request(
      harness.app,
      transferUrl(fixture.mlflowPath, fixture.runRoot, 'weights/model.bin'),
      {
        cookie: fixture.viewer.cookie,
      },
    );
    expect(download.status).toBe(200);
    expect(Buffer.from(await download.arrayBuffer()).equals(CONTENT)).toBe(true);
    // The part token stops working once the session left open.
    expect((await putPart(second, partBytes(2))).status).toBe(409);
    // A retried complete after a lost response reports success again.
    expect((await completeMultipart(fixture, created, etags)).status).toBe(200);
  });

  it('mpuで保存したlog_imageの画像は、通常のPUTと同じくその場でRunのmediaに索引される', async () => {
    const fixture = await artifactFixture(harness);
    // MLflow 3.17.0's log_image(key=, step=) name; the SDK sends the local file path.
    const fileName = 'sample+step+3+timestamp+1728370000123+b1b2c3d4-0000-4000-8000-000000000001.png';
    const options = { directory: 'images', localPath: `/tmp/mlflow/${fileName}` };
    const created = await entity<CreateResponse>(await createMultipart(fixture, options), 200);
    const etags = await putAllParts(created);
    const completed = await completeWhileFinalizing(
      completeMultipart(fixture, created, etags, options),
    );
    expect(completed.status).toBe(200);
    const media = await entity<{ items: { key: string; step: number; kind: string }[] }>(
      await request(harness.app, `${fixture.basePath}/runs/${fixture.run.id}/media`, {
        cookie: fixture.viewer.cookie,
      }),
      200,
    );
    expect(media.items).toMatchObject([{ key: 'sample', step: 3, kind: 'image' }]);
  });

  it('abortでsessionを閉じ、受け取ったpartを保存先に残さない', async () => {
    const fixture = await artifactFixture(harness);
    const created = await entity<CreateResponse>(await createMultipart(fixture), 200);
    expect((await putPart(created.credentials[0]!, partBytes(1))).status).toBe(200);
    expect(await partFiles()).toHaveLength(1);

    const aborted = await request(
      harness.app,
      mpuUrl(fixture, 'abort', fixture.runRoot, 'weights'),
      {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: { path: '/home/trainer/out/model.bin', upload_id: created.upload_id },
      },
    );

    expect(aborted.status).toBe(200);
    expect(await partFiles()).toEqual([]);
    expect((await putPart(created.credentials[1]!, partBytes(2))).status).toBe(409);
    const {
      rows: [session],
    } = await harness.database.query<{ status: string }>(
      'SELECT status FROM artifact_uploads WHERE id=$1',
      [created.upload_id],
    );
    expect(session!.status).toBe('aborted');
  });

  it('PENDINGのLogged Modelへ書き込み、READYのLogged Modelと登録モデル版へのcreateは409', async () => {
    const fixture = await artifactFixture(harness);
    const model = await fixture.loggedModel();
    const created = await entity<CreateResponse>(
      await createMultipart(fixture, { ownerRoot: model.root }),
      200,
    );
    const etags = await putAllParts(created);
    const completed = await completeWhileFinalizing(
      completeMultipart(fixture, created, etags, { ownerRoot: model.root }),
    );
    expect(completed.status).toBe(200);
    const listing = await request(
      harness.app,
      `${fixture.mlflowPath}/api/2.0/mlflow/logged-models/${model.id}/artifacts/directories?artifact_directory_path=weights`,
      { cookie: fixture.viewer.cookie },
    );
    expect(((await listing.json()) as { files: unknown[] }).files).toEqual([
      { path: 'weights/model.bin', is_dir: false, file_size: String(CONTENT.length) },
    ]);

    await harness.database.query("UPDATE mlflow_logged_models SET status='READY' WHERE id=$1", [
      model.id,
    ]);
    const ready = await createMultipart(fixture, { ownerRoot: model.root });
    expect(ready.status).toBe(409);
    expect(((await ready.json()) as { error_code: string }).error_code).toBe('INVALID_STATE');
    const version = await createMultipart(fixture, {
      ownerRoot: `model-versions/${crypto.randomUUID()}/artifacts`,
    });
    expect(version.status).toBe(409);
  });

  it('viewerと未認証はcreateできず、他人のsessionはcomplete・abortできない', async () => {
    const fixture = await artifactFixture(harness);
    const viewer = await request(harness.app, mpuUrl(fixture, 'create', fixture.runRoot), {
      method: 'POST',
      cookie: fixture.viewer.cookie,
      body: { path: 'model.bin', num_parts: 1 },
    });
    expect(viewer.status).toBe(403);
    const anonymous = await request(harness.app, mpuUrl(fixture, 'create', fixture.runRoot), {
      method: 'POST',
      body: { path: 'model.bin', num_parts: 1 },
    });
    expect(anonymous.status).toBe(401);

    const created = await entity<CreateResponse>(await createMultipart(fixture), 200);
    const etags = await putAllParts(created);
    await harness.database.query(
      `INSERT INTO project_members(project_id,user_id,role) VALUES($1,$2,'editor')`,
      [fixture.project.id, fixture.outsider.userId],
    );
    for (const action of ['complete', 'abort']) {
      const response = await request(
        harness.app,
        mpuUrl(fixture, action, fixture.runRoot, 'weights'),
        {
          method: 'POST',
          cookie: fixture.outsider.cookie,
          body: { path: '/home/trainer/out/model.bin', upload_id: created.upload_id, parts: [] },
        },
      );
      expect(response.status, action).toBe(403);
    }
    // complete must name the session's own Artifact path.
    const elsewhere = await request(
      harness.app,
      mpuUrl(fixture, 'complete', fixture.runRoot, 'other'),
      {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: {
          path: '/home/trainer/out/model.bin',
          upload_id: created.upload_id,
          parts: etags.map((etag, index) => ({ part_number: index + 1, etag })),
        },
      },
    );
    expect(elsewhere.status).toBe(422);
  });

  it('最後以外の小さいpartと、送信後に置き換えられたpartは拒否する', async () => {
    const fixture = await artifactFixture(harness);
    const created = await entity<CreateResponse>(await createMultipart(fixture), 200);
    const small = await putPart(created.credentials[0]!, Buffer.from('too small'));
    expect(small.status).toBe(422);
    expect(((await small.json()) as { message: string }).message).toContain('最後以外のpart');

    const etags = await putAllParts(created);
    expect(
      (await putPart(created.credentials[0]!, Buffer.alloc(MULTIPART_MIN_PART_BYTES, 'x'))).status,
    ).toBe(200);
    const replaced = await completeMultipart(fixture, created, etags);
    expect(replaced.status).toBe(409);
  });

  it('空のファイル（num_parts=0）はSDKが通常のPUTへ戻る501を返す', async () => {
    const fixture = await artifactFixture(harness);
    const response = await createMultipart(fixture, { numParts: 0 });
    expect(response.status).toBe(501);
    expect(
      ((await response.json()) as { message: string }).message.startsWith(SDK_FALLBACK_MESSAGE),
    ).toBe(true);
  });

  it('検証が待ち時間を超えたcompleteは503で、sessionは検証を続けて後で登録される', async () => {
    const application = createApplication({
      config: { ...harness.config, uploadFinalizeWaitMs: 0 },
      database: harness.database,
      stores: harness.stores,
    });
    const fixture = await artifactFixture(harness);
    const created = await entity<CreateResponse>(
      await createMultipart(fixture, { app: application.app }),
      200,
    );
    const etags = await putAllParts(created, application.app);

    const pending = await completeMultipart(fixture, created, etags, { app: application.app });

    expect(pending.status).toBe(503);
    expect(((await pending.json()) as { error_code: string }).error_code).toBe(
      'TEMPORARILY_UNAVAILABLE',
    );
    expect(await application.artifactUploadFinalizer.finalizeBatch()).toBe(1);
    const download = await request(
      harness.app,
      transferUrl(fixture.mlflowPath, fixture.runRoot, 'weights/model.bin'),
      {
        cookie: fixture.viewer.cookie,
      },
    );
    expect(Buffer.from(await download.arrayBuffer()).equals(CONTENT)).toBe(true);
  });

  it('MMT_MLFLOW_MULTIPART_UPLOADS=falseではserver-infoがfalseで、mpu/*はSDKが通常のPUTへ戻る501を返す', async () => {
    const application = createApplication({
      config: {
        ...harness.config,
        mlflowMultipart: { uploadsEnabled: false, downloadsEnabled: false },
      },
      database: harness.database,
      stores: harness.stores,
    });
    const fixture = await artifactFixture(harness);
    const info = await request(
      application.app,
      `${fixture.mlflowPath}/api/3.0/mlflow/server-info`,
      {
        cookie: fixture.viewer.cookie,
      },
    );
    expect(
      ((await info.json()) as { multipart_uploads_enabled: boolean }).multipart_uploads_enabled,
    ).toBe(false);
    for (const action of ['create', 'complete', 'abort']) {
      const response = await request(application.app, mpuUrl(fixture, action, fixture.runRoot), {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: { path: '/tmp/large.bin', num_parts: 2, upload_id: 'upload', parts: [] },
      });
      expect(response.status, action).toBe(501);
      const error = (await response.json()) as { error_code: string; message: string };
      expect(error.error_code).toBe('NOT_IMPLEMENTED');
      expect(error.message.startsWith(SDK_FALLBACK_MESSAGE)).toBe(true);
    }
    const anonymous = await request(application.app, mpuUrl(fixture, 'create', fixture.runRoot), {
      method: 'POST',
      body: { path: '/tmp/large.bin', num_parts: 1 },
    });
    expect(anonymous.status).toBe(401);
  });

  it('Job限定tokenは自分のRunへだけmpuでき、partとcompleteまで通る', async () => {
    const fixture = await executionFixture(harness);
    const own = await fixture.newRun('Training', 'training');
    const other = await fixture.newRun('Other', 'training');
    await entity<Job>(
      await request(harness.app, `${fixture.basePath}/jobs`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: { runId: own.id, targetId: fixture.target.id, gpuIds: [] },
      }),
    );
    const claimed = await entity<{ item: WorkerJob }>(
      await request(harness.app, '/api/worker/claim', {
        method: 'POST',
        token: fixture.workerToken,
        body: { workerId: 'multipart-worker' },
      }),
      200,
    );
    const jobToken = claimed.item.jobToken!;
    const mlflowPath = `/api/mlflow/projects/${fixture.project.id}`;
    const mpu = (action: string, runId: string, body: Record<string, unknown>) =>
      request(
        harness.app,
        `${mlflowPath}/api/2.0/mlflow-artifacts/mpu/${action}/runs/${runId}/artifacts/checkpoints`,
        { method: 'POST', token: jobToken, body: { path: '/work/model.bin', ...body } },
      );

    expect((await mpu('create', other.id, { num_parts: 2 })).status).toBe(403);
    const created = await entity<CreateResponse>(
      await mpu('create', own.id, { num_parts: 2 }),
      200,
    );
    const etags = await putAllParts(created);
    const completed = await completeWhileFinalizing(
      mpu('complete', own.id, {
        upload_id: created.upload_id,
        parts: etags.map((etag, index) => ({ part_number: index + 1, etag })),
      }),
    );

    expect(completed.status).toBe(200);
    const listing = await request(
      harness.app,
      `${mlflowPath}/api/2.0/mlflow/artifacts/list?run_id=${own.id}&path=checkpoints`,
      { token: jobToken },
    );
    expect(((await listing.json()) as { files: { path: string }[] }).files).toEqual([
      { path: 'checkpoints/model.bin', is_dir: false, file_size: String(CONTENT.length) },
    ]);
  });

  const s3Endpoint = process.env.MMT_TEST_S3_ENDPOINT;
  it.skipIf(!s3Endpoint)(
    'S3のProjectでも5MiBのpartで完了し、S3に未完了のmultipart uploadを残さない',
    async () => {
      const client = new S3Client({
        endpoint: s3Endpoint,
        region: 'us-east-1',
        forcePathStyle: true,
        // These values authenticate only to the isolated emulator, never to real storage.
        credentials: { accessKeyId: 'testing', secretAccessKey: 'testing' },
      });
      const bucket = `mmt-mlflow-mpu-test-${Date.now()}`;
      await client.send(new CreateBucketCommand({ Bucket: bucket }));
      const application = createApplication({
        config: harness.config,
        database: harness.database,
        stores: createArtifactStores({
          filesystem: createFilesystemArtifactStore(harness.artifactDirectory),
          s3: createS3ArtifactStore({ client, bucket, prefix: 'artifacts' }),
        }),
      });
      try {
        const fixture = await artifactFixture(harness);
        await entity(
          await request(application.app, fixture.basePath, {
            method: 'PATCH',
            cookie: fixture.administrator.cookie,
            body: { artifactBackend: 's3' },
          }),
          200,
        );
        const created = await entity<CreateResponse>(
          await createMultipart(fixture, { app: application.app }),
          200,
        );
        const etags = await putAllParts(created, application.app);
        const completed = await completeWhileFinalizing(
          completeMultipart(fixture, created, etags, { app: application.app }),
          application.artifactUploadFinalizer,
        );
        expect(completed.status).toBe(200);
        const download = await request(
          application.app,
          transferUrl(fixture.mlflowPath, fixture.runRoot, 'weights/model.bin'),
          { cookie: fixture.viewer.cookie },
        );
        expect(Buffer.from(await download.arrayBuffer()).equals(CONTENT)).toBe(true);
        const pending = await client.send(new ListMultipartUploadsCommand({ Bucket: bucket }));
        expect(pending.Uploads ?? []).toEqual([]);
      } finally {
        const objects = await client.send(new ListObjectsV2Command({ Bucket: bucket }));
        for (const object of objects.Contents ?? [])
          await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: object.Key! }));
        await client.send(new DeleteBucketCommand({ Bucket: bucket }));
        client.destroy();
      }
    },
  );
});
