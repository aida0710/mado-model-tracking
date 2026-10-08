import { createHash } from 'node:crypto';
import { readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  ListMultipartUploadsCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type { Artifact, ArtifactUpload, ArtifactUploadDetail, Run } from '@mmt/contracts';
import {
  createArtifactStores,
  createFilesystemArtifactStore,
  createS3ArtifactStore,
  MULTIPART_MIN_PART_BYTES,
  type ArtifactStores,
} from '@mmt/platform';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApplication } from '../src/app.js';
import { projectFixture } from './fixtures.js';
import { createHarness, entity, request, testDatabaseUrl, type Harness } from './harness.js';

const ORIGIN = 'http://127.0.0.1:5182';
// Two full parts and a short last part, the smallest shape that has a "middle" part to lose.
const PART_SIZE = MULTIPART_MIN_PART_BYTES;
const CONTENT = Buffer.concat([
  Buffer.alloc(PART_SIZE, 'a'),
  Buffer.alloc(PART_SIZE, 'b'),
  Buffer.from('last-part'),
]);
const CONTENT_SHA256 = createHash('sha256').update(CONTENT).digest('hex');

function partBytes(partNumber: number): Buffer {
  return CONTENT.subarray((partNumber - 1) * PART_SIZE, partNumber * PART_SIZE);
}

describe.skipIf(!testDatabaseUrl)('再開可能なupload session（独立PostgreSQL）', () => {
  let harness: Harness;

  async function storedFiles(): Promise<string[]> {
    const entries = await readdir(harness.artifactDirectory, {
      recursive: true,
      withFileTypes: true,
    });
    return entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
  }
  async function artifactCount(): Promise<number> {
    const result = await harness.database.query<{ count: string }>(
      'SELECT count(*) FROM artifacts',
    );
    return Number(result.rows[0]!.count);
  }

  async function fixtureWithRun() {
    const fixture = await projectFixture(harness);
    const run = await entity<Run>(
      await request(harness.app, `${fixture.basePath}/runs`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: { experimentId: fixture.experiment.id, name: 'Upload Run', kind: 'training' },
      }),
    );
    return { ...fixture, run };
  }
  type Fixture = Awaited<ReturnType<typeof fixtureWithRun>>;
  type Credential = { cookie?: string; token?: string };

  function createUpload(
    fixture: Fixture,
    credential: Credential,
    overrides: Record<string, unknown> = {},
    app = harness.app,
  ) {
    return request(app, `${fixture.basePath}/artifact-uploads`, {
      method: 'POST',
      ...credential,
      body: {
        path: 'audio/long.wav',
        runId: fixture.run.id,
        expectedSize: CONTENT.length,
        expectedSha256: CONTENT_SHA256,
        partSize: PART_SIZE,
        ...overrides,
      },
    });
  }
  function putPart(
    fixture: Fixture,
    credential: Credential,
    upload: { id: string },
    partNumber: number,
    options: { body?: BodyInit; length?: number; app?: Harness['app'] } = {},
  ) {
    const bytes = partBytes(partNumber);
    return request(
      options.app ?? harness.app,
      `${fixture.basePath}/artifact-uploads/${upload.id}/parts/${partNumber}`,
      {
        method: 'PUT',
        ...credential,
        headers: { 'Content-Length': String(options.length ?? bytes.length) },
        binary: options.body ?? new Uint8Array(bytes),
      },
    );
  }
  function uploadAction(
    fixture: Fixture,
    credential: Credential,
    upload: { id: string },
    action: 'complete' | 'abort' | 'get',
  ) {
    const base = `${fixture.basePath}/artifact-uploads/${upload.id}`;
    if (action === 'get') return request(harness.app, base, credential);
    return request(harness.app, action === 'complete' ? `${base}/complete` : base, {
      method: action === 'complete' ? 'POST' : 'DELETE',
      ...credential,
    });
  }
  async function uploadAllParts(fixture: Fixture, credential: Credential, upload: { id: string }) {
    for (const partNumber of [1, 2, 3])
      await entity(await putPart(fixture, credential, upload, partNumber), 200);
  }

  beforeAll(async () => {
    harness = await createHarness();
  });
  beforeEach(async () => {
    await harness.reset();
    for (const entry of await readdir(harness.artifactDirectory))
      await rm(path.join(harness.artifactDirectory, entry), { recursive: true, force: true });
  });
  afterAll(async () => {
    await harness?.close();
  });

  it('partの途中で切断しても、GETで欠けたpartが分かり、そのpartだけ再送してcompleteできる', async () => {
    const fixture = await fixtureWithRun();
    const editor = { cookie: fixture.editor.cookie };
    const upload = await entity<ArtifactUpload>(await createUpload(fixture, editor));
    expect(upload).toMatchObject({ status: 'open', partCount: 3, artifactId: null });
    await entity(await putPart(fixture, editor, upload, 1), 200);
    const interrupted = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(partBytes(2).subarray(0, 1024));
        controller.error(new Error('connection reset'));
      },
    });
    const cut = await Promise.resolve(
      harness.app.request(`${fixture.basePath}/artifact-uploads/${upload.id}/parts/2`, {
        method: 'PUT',
        headers: {
          Origin: ORIGIN,
          Cookie: editor.cookie,
          'Content-Length': String(PART_SIZE),
        },
        body: interrupted,
        duplex: 'half',
      } as RequestInit),
    ).catch(() => null);
    expect(cut === null || cut.status >= 400).toBe(true);
    await entity(await putPart(fixture, editor, upload, 3), 200);

    const resumed = await entity<ArtifactUploadDetail>(
      await uploadAction(fixture, editor, upload, 'get'),
      200,
    );
    expect(resumed.receivedParts.map((part) => part.partNumber)).toEqual([1, 3]);
    expect(resumed.receivedParts[0]).toMatchObject({
      size: PART_SIZE,
      sha256: createHash('sha256').update(partBytes(1)).digest('hex'),
    });
    await entity(await putPart(fixture, editor, upload, 2), 200);
    expect(
      await entity<ArtifactUpload>(await uploadAction(fixture, editor, upload, 'complete'), 202),
    ).toMatchObject({ status: 'verifying' });

    expect(await harness.artifactUploadFinalizer.finalizeBatch()).toBe(1);
    const completed = await entity<ArtifactUploadDetail>(
      await uploadAction(fixture, editor, upload, 'get'),
      200,
    );
    expect(completed).toMatchObject({ status: 'completed', artifactId: upload.id, error: null });
    const artifact = await entity<Artifact>(
      await request(harness.app, `${fixture.basePath}/artifacts/${upload.id}`, editor),
      200,
    );
    expect(artifact).toMatchObject({
      runId: fixture.run.id,
      path: 'audio/long.wav',
      mimeType: 'audio/wav',
      size: CONTENT.length,
      sha256: CONTENT_SHA256,
    });
    const downloaded = await request(
      harness.app,
      `${fixture.basePath}/artifacts/${upload.id}/content`,
      editor,
    );
    expect(Buffer.from(await downloaded.arrayBuffer()).equals(CONTENT)).toBe(true);
    // Only the assembled object remains; part files and the session directory are gone.
    expect(await storedFiles()).toEqual(['content']);
  });

  it('宣言と違う長さのpartは422で拒否し、受け取り済みとして記録しない', async () => {
    const fixture = await fixtureWithRun();
    const editor = { cookie: fixture.editor.cookie };
    const upload = await entity<ArtifactUpload>(await createUpload(fixture, editor));
    expect(
      await entity(await putPart(fixture, editor, upload, 3, { length: 4 }), 422),
    ).toMatchObject({ code: 'part_size_mismatch' });
    const corrupted = Buffer.from(partBytes(3));
    corrupted[0] = 0;
    const checked = await request(
      harness.app,
      `${fixture.basePath}/artifact-uploads/${upload.id}/parts/3`,
      {
        method: 'PUT',
        ...editor,
        headers: {
          'Content-Length': String(corrupted.length),
          'X-Part-SHA256': createHash('sha256').update(partBytes(3)).digest('hex'),
        },
        binary: new Uint8Array(corrupted),
      },
    );
    expect(await entity(checked, 422)).toMatchObject({ code: 'part_checksum_mismatch' });
    expect(
      (await entity<ArtifactUploadDetail>(await uploadAction(fixture, editor, upload, 'get'), 200))
        .receivedParts,
    ).toEqual([]);
    expect(
      await entity(await uploadAction(fixture, editor, upload, 'complete'), 409),
    ).toMatchObject({ code: 'upload_incomplete' });
  });

  it('expectedSha256が一致しなければfailedになり、ArtifactもblobもDB行も残さない', async () => {
    const fixture = await fixtureWithRun();
    const editor = { cookie: fixture.editor.cookie };
    const upload = await entity<ArtifactUpload>(
      await createUpload(fixture, editor, { expectedSha256: 'f'.repeat(64) }),
    );
    await uploadAllParts(fixture, editor, upload);
    await entity(await uploadAction(fixture, editor, upload, 'complete'), 202);

    await harness.artifactUploadFinalizer.finalizeBatch();

    expect(
      await entity<ArtifactUpload>(await uploadAction(fixture, editor, upload, 'get'), 200),
    ).toMatchObject({ status: 'failed', error: 'sha256_mismatch', artifactId: null });
    expect(await artifactCount()).toBe(0);
    expect(await storedFiles()).toEqual([]);
  });

  it('viewerは作成できず、作成者以外のユーザーや別のtokenはsessionを使えない', async () => {
    const fixture = await fixtureWithRun();
    const editor = { cookie: fixture.editor.cookie };
    expect(
      await entity(await createUpload(fixture, { cookie: fixture.viewer.cookie }), 403),
    ).toMatchObject({ code: 'project_forbidden' });
    const minted = await entity<{ token: string }>(
      await request(harness.app, '/api/tokens', {
        method: 'POST',
        ...editor,
        body: {
          name: 'Upload token',
          kind: 'personal',
          projectId: fixture.project.id,
          scopes: ['artifacts:write'],
        },
      }),
    );
    const readOnly = await entity<{ token: string }>(
      await request(harness.app, '/api/tokens', {
        method: 'POST',
        ...editor,
        body: {
          name: 'Read token',
          kind: 'personal',
          projectId: fixture.project.id,
          scopes: ['read'],
        },
      }),
    );
    expect(await entity(await createUpload(fixture, { token: readOnly.token }), 403)).toMatchObject(
      { code: 'insufficient_scope' },
    );
    const upload = await entity<ArtifactUpload>(await createUpload(fixture, editor));

    for (const other of [{ cookie: fixture.administrator.cookie }, { token: minted.token }]) {
      expect(await entity(await putPart(fixture, other, upload, 1), 403)).toMatchObject({
        code: 'upload_forbidden',
      });
      expect(await entity(await uploadAction(fixture, other, upload, 'get'), 403)).toMatchObject({
        code: 'upload_forbidden',
      });
      expect(
        await entity(await uploadAction(fixture, other, upload, 'complete'), 403),
      ).toMatchObject({ code: 'upload_forbidden' });
      expect(
        (
          await entity<{ items: ArtifactUpload[] }>(
            await request(harness.app, `${fixture.basePath}/artifact-uploads?status=open`, other),
            200,
          )
        ).items,
      ).toEqual([]);
    }
    expect(
      (
        await entity<{ items: ArtifactUpload[] }>(
          await request(harness.app, `${fixture.basePath}/artifact-uploads?status=open`, editor),
          200,
        )
      ).items.map((item) => item.id),
    ).toEqual([upload.id]);
    expect(
      await entity(await putPart(fixture, { cookie: fixture.outsider.cookie }, upload, 1), 403),
    ).toMatchObject({ code: 'project_forbidden' });
  });

  it('期限切れのsessionはsweepでexpiredになり、保存先のmultipart uploadをabortする', async () => {
    const fixture = await fixtureWithRun();
    const editor = { cookie: fixture.editor.cookie };
    const aborted: string[] = [];
    const filesystem = harness.stores.multipart('filesystem')!;
    const stores: ArtifactStores = {
      ...harness.stores,
      multipart: () => ({
        ...filesystem,
        async abortMultipart(upload) {
          aborted.push(upload.backendUploadId);
          await filesystem.abortMultipart(upload);
        },
      }),
    };
    const application = createApplication({
      config: harness.config,
      database: harness.database,
      stores,
    });
    const upload = await entity<ArtifactUpload>(
      await createUpload(fixture, editor, {}, application.app),
    );
    await entity(await putPart(fixture, editor, upload, 1, { app: application.app }), 200);
    const {
      rows: [session],
    } = await harness.database.query<{ backend_upload_id: string }>(
      "UPDATE artifact_uploads SET expires_at=now()-interval '1 second' WHERE id=$1 RETURNING backend_upload_id",
      [upload.id],
    );
    expect(
      await entity(await putPart(fixture, editor, upload, 2, { app: application.app }), 409),
    ).toMatchObject({ code: 'upload_expired' });

    expect(await application.artifactUploadSweeper.sweep()).toMatchObject({ expiredSessions: 1 });

    expect(aborted).toEqual([session!.backend_upload_id]);
    expect(
      await entity<ArtifactUpload>(await uploadAction(fixture, editor, upload, 'get'), 200),
    ).toMatchObject({ status: 'expired' });
    expect(await storedFiles()).toEqual([]);
    expect(await application.artifactUploadSweeper.sweep()).toMatchObject({ expiredSessions: 0 });
  });

  it('finalizerの途中でAPIが止まっても、再起動後にverifyingから完了する', async () => {
    const fixture = await fixtureWithRun();
    const editor = { cookie: fixture.editor.cookie };
    const upload = await entity<ArtifactUpload>(await createUpload(fixture, editor));
    await uploadAllParts(fixture, editor, upload);
    await entity(await uploadAction(fixture, editor, upload, 'complete'), 202);
    // The first process assembles the object and then stops while reading it back.
    const stopping = createApplication({
      config: harness.config,
      database: harness.database,
      stores: {
        ...harness.stores,
        read: async () => {
          throw new Error('process stopped');
        },
      },
    });
    await stopping.artifactUploadFinalizer.finalizeBatch();
    expect(
      await entity<ArtifactUpload>(await uploadAction(fixture, editor, upload, 'get'), 200),
    ).toMatchObject({ status: 'verifying' });
    // A live lease blocks a second finalizer until it lapses.
    const restarted = createApplication({
      config: harness.config,
      database: harness.database,
      stores: harness.stores,
    });
    expect(await restarted.artifactUploadFinalizer.finalizeBatch()).toBe(0);
    await harness.database.query(
      "UPDATE artifact_uploads SET finalizer_locked_at=now()-interval '1 hour' WHERE id=$1",
      [upload.id],
    );

    expect(await restarted.artifactUploadFinalizer.finalizeBatch()).toBe(1);

    expect(
      await entity<ArtifactUpload>(await uploadAction(fixture, editor, upload, 'get'), 200),
    ).toMatchObject({ status: 'completed', artifactId: upload.id });
    expect(await artifactCount()).toBe(1);
  });

  it('completeを2回送り、finalizerが並行しても、Artifactは1件だけ登録される', async () => {
    const fixture = await fixtureWithRun();
    const editor = { cookie: fixture.editor.cookie };
    const upload = await entity<ArtifactUpload>(await createUpload(fixture, editor));
    await uploadAllParts(fixture, editor, upload);
    const [first, second] = await Promise.all([
      uploadAction(fixture, editor, upload, 'complete'),
      uploadAction(fixture, editor, upload, 'complete'),
    ]);
    expect([first.status, second.status]).toEqual([202, 202]);
    const another = createApplication({
      config: harness.config,
      database: harness.database,
      stores: harness.stores,
    });

    await Promise.all([
      harness.artifactUploadFinalizer.finalizeBatch(),
      another.artifactUploadFinalizer.finalizeBatch(),
    ]);

    expect(
      await entity<ArtifactUpload>(await uploadAction(fixture, editor, upload, 'complete'), 202),
    ).toMatchObject({ status: 'completed' });
    expect(await artifactCount()).toBe(1);
    expect(await entity(await putPart(fixture, editor, upload, 1), 409)).toMatchObject({
      code: 'upload_not_open',
    });
  });

  it('Runをsoft-deleteした後のcompleteは409で、検証中に削除されたらfailedにしてblobを消す', async () => {
    const fixture = await fixtureWithRun();
    const editor = { cookie: fixture.editor.cookie };
    const beforeDelete = await entity<ArtifactUpload>(await createUpload(fixture, editor));
    await uploadAllParts(fixture, editor, beforeDelete);
    await entity(await uploadAction(fixture, editor, beforeDelete, 'complete'), 202);
    const afterDelete = await entity<ArtifactUpload>(
      await createUpload(fixture, editor, { path: 'audio/other.wav' }),
    );
    await uploadAllParts(fixture, editor, afterDelete);
    await entity(
      await request(
        harness.app,
        `/api/mlflow/projects/${fixture.project.id}/api/2.0/mlflow/runs/delete`,
        { method: 'POST', ...editor, body: { run_id: fixture.run.id } },
      ),
      200,
    );

    expect(
      await entity(await uploadAction(fixture, editor, afterDelete, 'complete'), 409),
    ).toMatchObject({ code: 'run_deleted' });
    await harness.artifactUploadFinalizer.finalizeBatch();
    expect(
      await entity<ArtifactUpload>(await uploadAction(fixture, editor, beforeDelete, 'get'), 200),
    ).toMatchObject({ status: 'failed', error: 'run_deleted' });
    expect(await artifactCount()).toBe(0);
    expect(await entity(await createUpload(fixture, editor), 409)).toMatchObject({
      code: 'run_deleted',
    });
  });

  it('abortしたsessionはpartを受け付けず、保存先にファイルを残さない', async () => {
    const fixture = await fixtureWithRun();
    const editor = { cookie: fixture.editor.cookie };
    const upload = await entity<ArtifactUpload>(await createUpload(fixture, editor));
    await entity(await putPart(fixture, editor, upload, 1), 200);

    expect(
      await entity<ArtifactUpload>(await uploadAction(fixture, editor, upload, 'abort'), 200),
    ).toMatchObject({ status: 'aborted' });

    expect(await storedFiles()).toEqual([]);
    expect(await entity(await putPart(fixture, editor, upload, 2), 409)).toMatchObject({
      code: 'upload_not_open',
    });
    expect(await entity(await uploadAction(fixture, editor, upload, 'abort'), 200)).toMatchObject({
      status: 'aborted',
    });
  });

  it('part数が上限を超える指定と、上限サイズを超えるArtifactは作成時に拒否する', async () => {
    const fixture = await fixtureWithRun();
    const editor = { cookie: fixture.editor.cookie };
    expect(
      await entity(await createUpload(fixture, editor, { expectedSize: PART_SIZE * 10_001 }), 422),
    ).toMatchObject({ code: 'too_many_parts' });
    expect(
      await entity(await createUpload(fixture, editor, { partSize: 1024 }), 422),
    ).toMatchObject({ code: 'invalid_part_size' });
    const limited = createApplication({
      config: { ...harness.config, artifactMaxBytes: PART_SIZE },
      database: harness.database,
      stores: harness.stores,
    });
    expect(await entity(await createUpload(fixture, editor, {}, limited.app), 413)).toMatchObject({
      code: 'artifact_too_large',
    });
    expect(await storedFiles()).toEqual([]);
  });

  const s3Endpoint = process.env.MMT_TEST_S3_ENDPOINT;
  it.skipIf(!s3Endpoint)(
    'S3では期限切れsessionのAbortMultipartUploadが送られ、partが残らない',
    async () => {
      const client = new S3Client({
        endpoint: s3Endpoint,
        region: 'us-east-1',
        forcePathStyle: true,
        // These values authenticate only to the isolated emulator, never to real storage.
        credentials: { accessKeyId: 'testing', secretAccessKey: 'testing' },
      });
      const bucket = `mmt-upload-test-${Date.now()}`;
      await client.send(new CreateBucketCommand({ Bucket: bucket }));
      const stores = createArtifactStores({
        filesystem: createFilesystemArtifactStore(harness.artifactDirectory),
        s3: createS3ArtifactStore({ client, bucket, prefix: 'artifacts' }),
      });
      const application = createApplication({
        config: harness.config,
        database: harness.database,
        stores,
      });
      try {
        const fixture = await fixtureWithRun();
        const editor = { cookie: fixture.editor.cookie };
        await entity(
          await request(application.app, fixture.basePath, {
            method: 'PATCH',
            cookie: fixture.administrator.cookie,
            body: { artifactBackend: 's3' },
          }),
          200,
        );
        const upload = await entity<ArtifactUpload>(
          await createUpload(fixture, editor, {}, application.app),
        );
        expect(upload.backend).toBe('s3');
        await entity(await putPart(fixture, editor, upload, 1, { app: application.app }), 200);
        const pending = async () =>
          (await client.send(new ListMultipartUploadsCommand({ Bucket: bucket }))).Uploads ?? [];
        expect(await pending()).toHaveLength(1);
        await harness.database.query(
          "UPDATE artifact_uploads SET expires_at=now()-interval '1 second' WHERE id=$1",
          [upload.id],
        );

        expect(await application.artifactUploadSweeper.sweep()).toMatchObject({
          expiredSessions: 1,
        });

        expect(await pending()).toEqual([]);
      } finally {
        await client.send(new DeleteBucketCommand({ Bucket: bucket }));
        client.destroy();
      }
    },
  );
});
