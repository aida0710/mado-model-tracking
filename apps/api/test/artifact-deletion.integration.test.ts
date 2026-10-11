import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, stat, unlink, utimes, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { serve } from '@hono/node-server';
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  HeadObjectCommand,
  ListMultipartUploadsCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type { Artifact, ArtifactUsage, Dataset, Model, Run } from '@mmt/contracts';
import {
  createArtifactStores,
  createFilesystemArtifactStore,
  createS3ArtifactStore,
  type ArtifactStores,
} from '@mmt/platform';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApplication } from '../src/app.js';
import { ArtifactGarbageCollector } from '../src/services/artifactGarbageCollector.js';
import { projectFixture } from './fixtures.js';
import { createHarness, entity, request, testDatabaseUrl, type Harness } from './harness.js';
import { transferUrl } from './mlflow-artifacts-fixtures.js';
import { registeredVersionFixture } from './mlflow-artifacts-version-fixtures.js';
import { mlflowSdkPythonPath } from './mlflow-sdk-fixtures.js';

const DAY_MS = 24 * 60 * 60 * 1000;
// Past the default 7-day grace period of MMT_ARTIFACT_DELETE_GRACE_DAYS.
const AFTER_GRACE_MS = 8 * DAY_MS;
// The task allows 47020-47029 for servers started by verification.
const SDK_TEST_HTTP_PORT = Number(process.env.MMT_TEST_HTTP_PORT ?? 47027);

describe.skipIf(!testDatabaseUrl)('Artifactの削除とgarbage collection（独立PostgreSQL）', () => {
  let harness: Harness;
  beforeAll(async () => {
    harness = await createHarness();
  });
  afterAll(async () => {
    await harness?.close();
  });
  beforeEach(async () => {
    await harness.reset();
  });

  async function fixtureWithRun() {
    const fixture = await projectFixture(harness);
    const run = await entity<Run>(
      await request(harness.app, `${fixture.basePath}/runs`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: { experimentId: fixture.experiment.id, name: 'Deletion Run', kind: 'training' },
      }),
    );
    async function upload(artifactPath: string, contents: string): Promise<Artifact> {
      return entity<Artifact>(
        await request(
          harness.app,
          `${fixture.basePath}/runs/${run.id}/artifacts?path=${encodeURIComponent(artifactPath)}`,
          { method: 'PUT', cookie: fixture.editor.cookie, binary: contents },
        ),
      );
    }
    function deleteArtifact(artifactId: string, cookie = fixture.administrator.cookie) {
      return request(harness.app, `${fixture.basePath}/artifacts/${artifactId}`, {
        method: 'DELETE',
        cookie,
      });
    }
    function content(artifactId: string) {
      return request(harness.app, `${fixture.basePath}/artifacts/${artifactId}/content`, {
        cookie: fixture.viewer.cookie,
      });
    }
    async function listedPaths(versions: 'latest' | 'all' = 'latest'): Promise<string[]> {
      const page = await entity<{ items: Artifact[] }>(
        await request(
          harness.app,
          `${fixture.basePath}/runs/${run.id}/artifacts?versions=${versions}`,
          { cookie: fixture.viewer.cookie },
        ),
        200,
      );
      return page.items.map((artifact) => `${artifact.path}:${artifact.id}`);
    }
    return { ...fixture, run, upload, deleteArtifact, content, listedPaths };
  }

  function blobPath(artifact: Artifact): string {
    return path.join(harness.artifactDirectory, artifact.storageKey);
  }

  async function blobExists(artifact: Artifact): Promise<boolean> {
    return stat(blobPath(artifact)).then(
      () => true,
      () => false,
    );
  }

  it('editorは削除できず、Project adminの削除で一覧・contentから消えて監査に残る', async () => {
    const fixture = await fixtureWithRun();
    const artifact = await fixture.upload('outputs/result.json', '{"score":1}');

    expect(
      await entity(await fixture.deleteArtifact(artifact.id, fixture.editor.cookie), 403),
    ).toMatchObject({ code: 'project_forbidden' });
    expect((await fixture.content(artifact.id)).status).toBe(200);

    const deleted = await entity<Artifact>(await fixture.deleteArtifact(artifact.id), 200);
    expect(deleted.deletedAt).toEqual(expect.any(String));
    expect((await fixture.content(artifact.id)).status).toBe(404);
    expect(
      (
        await request(harness.app, `${fixture.basePath}/artifacts/${artifact.id}`, {
          cookie: fixture.viewer.cookie,
        })
      ).status,
    ).toBe(404);
    expect(await fixture.listedPaths('all')).toEqual([]);
    expect((await fixture.deleteArtifact(artifact.id)).status).toBe(404);
    // The blob waits for the grace period.
    expect(await blobExists(artifact)).toBe(true);

    const audit = await harness.database.query<{ action: string; outcome: string }>(
      `SELECT action,outcome FROM audit_events WHERE resource_id=$1 ORDER BY occurred_at,id`,
      [artifact.id],
    );
    expect(audit.rows).toEqual([
      { action: 'artifact.delete', outcome: 'denied' },
      { action: 'artifact.delete', outcome: 'success' },
    ]);
  });

  it('最新バージョンを消すと同じpathの前のバージョンが現在のバージョンになる', async () => {
    const fixture = await fixtureWithRun();
    const first = await fixture.upload('metrics.csv', 'step,loss\n1,0.9\n');
    const second = await fixture.upload('metrics.csv', 'step,loss\n1,0.5\n');
    expect(await fixture.listedPaths()).toEqual([`metrics.csv:${second.id}`]);

    await entity(await fixture.deleteArtifact(second.id), 200);

    expect(await fixture.listedPaths()).toEqual([`metrics.csv:${first.id}`]);
  });

  it('モデルバージョン・DatasetVersion・保持中checkpointから参照されている間は409で、隠したcheckpointのファイルは消せる', async () => {
    const fixture = await fixtureWithRun();
    const weights = await fixture.upload('model/weights.bin', 'weights');
    const sample = await fixture.upload('data/sample.wav', 'RIFF');
    const checkpointFile = await fixture.upload('checkpoints/step-1/state.pt', 'state');

    const model = await entity<Model>(
      await request(harness.app, `${fixture.basePath}/models`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: { name: 'Protected Model', family: 'qwen2' },
      }),
    );
    await entity(
      await request(harness.app, `${fixture.basePath}/models/${model.id}/versions`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: { artifactId: weights.id },
      }),
    );
    const dataset = await entity<Dataset>(
      await request(harness.app, `${fixture.basePath}/datasets`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: { name: 'Protected Dataset' },
      }),
    );
    await entity(
      await request(harness.app, `${fixture.basePath}/datasets/${dataset.id}/versions`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: {
          version: 'v1',
          content: { kind: 'artifacts', files: [{ path: 'sample.wav', artifactId: sample.id }] },
        },
      }),
    );
    const {
      rows: [checkpoint],
    } = await harness.database.query<{ id: string }>(
      `INSERT INTO run_checkpoints(project_id,run_id,step,source,artifact_ids,manifest)
       VALUES($1,$2,1,'mlflow',ARRAY[$3::uuid],'{"files":[]}') RETURNING id`,
      [fixture.project.id, fixture.run.id, checkpointFile.id],
    );

    for (const [artifact, label] of [
      [weights, '登録モデルバージョン'],
      [sample, 'DatasetVersion'],
      [checkpointFile, '保持中のcheckpoint'],
    ] as const) {
      const refused = await entity<{ code: string; error: string }>(
        await fixture.deleteArtifact(artifact.id),
        409,
      );
      expect(refused.code).toBe('artifact_in_use');
      expect(refused.error).toContain(label);
      expect((await fixture.content(artifact.id)).status).toBe(200);
    }

    await harness.database.query('UPDATE run_checkpoints SET retained=false WHERE id=$1', [
      checkpoint!.id,
    ]);
    await entity(await fixture.deleteArtifact(checkpointFile.id), 200);
  });

  it('削除済みArtifactへの新しい参照は作れない', async () => {
    const fixture = await fixtureWithRun();
    const artifact = await fixture.upload('model/weights.bin', 'weights');
    await entity(await fixture.deleteArtifact(artifact.id), 200);
    const model = await entity<Model>(
      await request(harness.app, `${fixture.basePath}/models`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: { name: 'Late Model', family: 'qwen2' },
      }),
    );

    expect(
      (
        await request(harness.app, `${fixture.basePath}/models/${model.id}/versions`, {
          method: 'POST',
          cookie: fixture.editor.cookie,
          body: { artifactId: artifact.id },
        })
      ).status,
    ).toBe(404);
    // The DB refuses the reference even for a writer that skips the service's lookup.
    await expect(
      harness.database.query(
        `INSERT INTO mlflow_artifact_paths(project_id,owner_kind,owner_id,path,artifact_id)
         VALUES($1,'run',$2,'model/weights.bin',$3)`,
        [fixture.project.id, fixture.run.id, artifact.id],
      ),
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('猶予を過ぎるとGCがblobを消し、使用量の削除待ちが0になる', async () => {
    const fixture = await fixtureWithRun();
    const artifact = await fixture.upload('audio/long.wav', 'RIFF-bytes');
    await entity(await fixture.deleteArtifact(artifact.id), 200);
    const usage = async () =>
      entity<ArtifactUsage>(
        await request(harness.app, `${fixture.basePath}/artifact-usage`, {
          cookie: fixture.viewer.cookie,
        }),
        200,
      );
    expect((await usage()).backends).toEqual([
      expect.objectContaining({ backend: 'filesystem', pendingDeletionCount: 1 }),
    ]);

    expect(
      await harness.artifactGarbageCollector.collect(new Date(Date.now() + DAY_MS)),
    ).toMatchObject({ removedBlobs: 0 });
    expect(await blobExists(artifact)).toBe(true);

    expect(
      await harness.artifactGarbageCollector.collect(new Date(Date.now() + AFTER_GRACE_MS)),
    ).toMatchObject({ removedBlobs: 1, failedBlobs: 0 });
    expect(await blobExists(artifact)).toBe(false);
    expect((await usage()).backends).toEqual([]);
  });

  it('GCのblob削除が途中で失敗しても、次の実行で回収する', async () => {
    const fixture = await fixtureWithRun();
    const first = await fixture.upload('a.bin', 'first');
    const second = await fixture.upload('b.bin', 'second');
    await entity(await fixture.deleteArtifact(first.id), 200);
    await entity(await fixture.deleteArtifact(second.id), 200);
    const registry = harness.services.artifactStores;
    let remainingFailures = 1;
    const flakyStores: ArtifactStores = {
      backends: () => registry.backends(),
      put: (write) => registry.put(write),
      read: (read) => registry.read(read),
      multipart: (backend) => registry.multipart(backend),
      async remove(reference) {
        if (remainingFailures-- > 0)
          throw Object.assign(new Error('storage unavailable'), { name: 'StorageUnavailable' });
        return registry.remove(reference);
      },
    };
    const collector = new ArtifactGarbageCollector({
      database: harness.database,
      stores: flakyStores,
      uploadSweeper: harness.artifactUploadSweeper,
      deleteGraceDays: 7,
    });
    const later = new Date(Date.now() + AFTER_GRACE_MS);

    expect(await collector.collect(later)).toMatchObject({ removedBlobs: 1, failedBlobs: 1 });
    const failed = await harness.database.query<{
      removal_attempts: number;
      last_removal_error: string;
    }>(
      `SELECT removal_attempts,last_removal_error FROM artifact_deletions
       WHERE blob_removed_at IS NULL`,
    );
    expect(failed.rows).toEqual([
      { removal_attempts: 1, last_removal_error: 'StorageUnavailable' },
    ]);

    expect(await collector.collect(later)).toMatchObject({ removedBlobs: 1, failedBlobs: 0 });
    expect([await blobExists(first), await blobExists(second)]).toEqual([false, false]);
  });

  it('blobを消した後にDB更新が失われていても、再実行で回収済みにする', async () => {
    const fixture = await fixtureWithRun();
    const artifact = await fixture.upload('lost.bin', 'bytes');
    await entity(await fixture.deleteArtifact(artifact.id), 200);
    await unlink(blobPath(artifact));

    expect(
      await harness.artifactGarbageCollector.collect(new Date(Date.now() + AFTER_GRACE_MS)),
    ).toMatchObject({ removedBlobs: 1, failedBlobs: 0 });
  });

  it('使用量は保存先ごとに、参照されていない古いバージョンを数える', async () => {
    const fixture = await fixtureWithRun();
    await fixture.upload('a.txt', '1111');
    await fixture.upload('a.txt', '22');
    const referenced = await fixture.upload('model.bin', '333');
    await fixture.upload('model.bin', '4');
    const model = await entity<Model>(
      await request(harness.app, `${fixture.basePath}/models`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: { name: 'Usage Model', family: 'qwen2' },
      }),
    );
    await entity(
      await request(harness.app, `${fixture.basePath}/models/${model.id}/versions`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: { artifactId: referenced.id },
      }),
    );
    const usage = await entity<ArtifactUsage>(
      await request(harness.app, `${fixture.basePath}/artifact-usage`, {
        cookie: fixture.viewer.cookie,
      }),
      200,
    );
    expect(usage).toEqual({
      deleteGraceDays: 7,
      backends: [
        {
          backend: 'filesystem',
          artifactCount: 4,
          totalBytes: 10,
          pendingDeletionCount: 0,
          pendingDeletionBytes: 0,
          // Only the first a.txt: the older model.bin is referenced by the model version.
          unreferencedOldVersionCount: 1,
          unreferencedOldVersionBytes: 4,
        },
      ],
    });
    expect(
      (
        await request(harness.app, `${fixture.basePath}/artifact-usage`, {
          cookie: fixture.outsider.cookie,
        })
      ).status,
    ).toBe(403);
  });

  it('MLflowのDELETEは参照されていないバージョンだけを消し、登録モデルバージョンのbytesは変わらない', async () => {
    const fixture = await registeredVersionFixture(harness, 'run');
    // A newer upload replaces the registered bytes at the path; only the newer one is unreferenced.
    await entity(
      await request(
        harness.app,
        transferUrl(fixture.mlflowPath, fixture.runRoot, 'saved/model.pkl'),
        { method: 'PUT', cookie: fixture.editor.cookie, binary: 'retrained weights' },
      ),
      200,
    );
    const deleteUrl = transferUrl(fixture.mlflowPath, fixture.runRoot, 'saved');
    expect(
      (await request(harness.app, deleteUrl, { method: 'DELETE', cookie: fixture.editor.cookie }))
        .status,
    ).toBe(403);

    expect(
      await entity(
        await request(harness.app, deleteUrl, {
          method: 'DELETE',
          cookie: fixture.administrator.cookie,
        }),
        200,
      ),
    ).toEqual({});

    const listed = await entity<{ files?: { path: string }[] }>(
      await request(
        harness.app,
        `${fixture.mlflowPath}/api/2.0/mlflow/artifacts/list?run_id=${fixture.run.id}&path=saved`,
        { cookie: fixture.viewer.cookie },
      ),
      200,
    );
    expect(listed.files ?? []).toEqual([]);
    expect(
      (
        await request(
          harness.app,
          transferUrl(fixture.mlflowPath, fixture.runRoot, 'saved/model.pkl'),
          { cookie: fixture.viewer.cookie },
        )
      ).status,
    ).toBe(404);
    const registered = await request(
      harness.app,
      transferUrl(fixture.mlflowPath, fixture.versionRoot, 'model.pkl'),
      { cookie: fixture.viewer.cookie },
    );
    expect(registered.status).toBe(200);
    expect(await registered.text()).toBe('fixed weights');
    const stored = await harness.database.query<{ deleted: number; kept: number }>(
      `SELECT count(*) FILTER (WHERE deleted_at IS NOT NULL)::int AS deleted,
              count(*) FILTER (WHERE deleted_at IS NULL)::int AS kept
       FROM artifacts WHERE run_id=$1 AND path LIKE 'saved/%'`,
      [fixture.run.id],
    );
    expect(stored.rows).toEqual([{ deleted: 1, kept: 3 }]);
    // Deleting the same path again succeeds, as on the MLflow server.
    expect(
      (
        await request(harness.app, deleteUrl, {
          method: 'DELETE',
          cookie: fixture.administrator.cookie,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await request(
          harness.app,
          transferUrl(fixture.mlflowPath, fixture.versionRoot, 'model.pkl'),
          { method: 'DELETE', cookie: fixture.administrator.cookie },
        )
      ).status,
    ).toBe(409);
  });

  it.skipIf(!existsSync(mlflowSdkPythonPath))(
    '公式SDKのdelete_artifactsでRunの一覧・取得から消え、登録モデルバージョンはそのまま読める',
    async () => {
      const fixture = await registeredVersionFixture(harness, 'run');
      await entity(
        await request(
          harness.app,
          transferUrl(fixture.mlflowPath, fixture.runRoot, 'notes/summary.txt'),
          { method: 'PUT', cookie: fixture.editor.cookie, binary: 'summary' },
        ),
        200,
      );
      const minted = await entity<{ token: string }>(
        await request(harness.app, '/api/tokens', {
          method: 'POST',
          cookie: fixture.administrator.cookie,
          body: {
            name: 'mlflow-sdk-delete',
            kind: 'personal',
            projectId: fixture.project.id,
            scopes: ['read', 'artifacts:write'],
          },
        }),
      );
      const server = serve({
        fetch: harness.app.fetch,
        hostname: '127.0.0.1',
        port: SDK_TEST_HTTP_PORT,
      });
      await new Promise<void>((resolve) => server.once('listening', () => resolve()));
      try {
        const { port } = server.address() as AddressInfo;
        const script = [
          'import json, os, sys, tempfile',
          'import mlflow',
          'from mlflow.store.artifact.artifact_repository_registry import get_artifact_repository',
          'client = mlflow.MlflowClient()',
          'run_id, name, version = sys.argv[1:4]',
          'repository = get_artifact_repository(client.get_run(run_id).info.artifact_uri)',
          'repository.delete_artifacts("saved")',
          'repository.delete_artifacts("notes/summary.txt")',
          'listed = [entry.path for entry in client.list_artifacts(run_id)]',
          'try:',
          '    client.download_artifacts(run_id, "saved/model.pkl", tempfile.mkdtemp())',
          '    run_download = "ALLOWED"',
          'except Exception as error:',
          '    run_download = type(error).__name__',
          'target = mlflow.artifacts.download_artifacts(f"models:/{name}/{version}", dst_path=tempfile.mkdtemp())',
          'with open(os.path.join(target, "model.pkl")) as weights:',
          '    registered = weights.read()',
          'print(json.dumps({"listed": listed, "runDownload": run_download, "registered": registered}))',
        ].join('\n');
        const result = await promisify(execFile)(
          mlflowSdkPythonPath,
          ['-c', script, fixture.run.id, fixture.name, fixture.version],
          {
            env: {
              ...process.env,
              MLFLOW_TRACKING_URI: `http://127.0.0.1:${port}${fixture.mlflowPath}`,
              MLFLOW_TRACKING_TOKEN: minted.token,
              MLFLOW_HTTP_REQUEST_MAX_RETRIES: '0',
              MLFLOW_DISABLE_AGENT_HINT: '1',
            },
          },
        );
        const outcome = JSON.parse(result.stdout.trim().split('\n').at(-1)!) as {
          listed: string[];
          runDownload: string;
          registered: string;
        };
        expect(outcome.listed).toEqual([]);
        expect(outcome.runDownload).not.toBe('ALLOWED');
        expect(outcome.registered).toBe('fixed weights');
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    },
    60_000,
  );

  it('GCは古い書きかけstagingと、sessionの無い古いmultipart uploadを回収する', async () => {
    const fixture = await fixtureWithRun();
    const stagingDirectory = path.join(harness.artifactDirectory, fixture.project.id, randomUUID());
    await mkdir(stagingDirectory, { recursive: true });
    const stagingFile = path.join(stagingDirectory, `content.${randomUUID()}.upload`);
    await writeFile(stagingFile, 'partial');
    const twoDaysAgo = new Date(Date.now() - 2 * DAY_MS);
    await utimes(stagingFile, twoDaysAgo, twoDaysAgo);
    const multipart = harness.services.artifactStores.multipart('filesystem')!;
    const { backendUploadId } = await multipart.createMultipart({
      key: `${fixture.project.id}/${randomUUID()}/content`,
      mimeType: 'application/octet-stream',
    });

    const collection = await harness.artifactGarbageCollector.collect(
      new Date(Date.now() + AFTER_GRACE_MS),
    );

    expect(collection.uploads).toMatchObject({ abortedOrphanedUploads: 1, removedStagingFiles: 1 });
    expect(existsSync(stagingFile)).toBe(false);
    expect(
      (await multipart.listIncompleteUploads()).map((upload) => upload.backendUploadId),
    ).not.toContain(backendUploadId);
  });

  const s3Endpoint = process.env.MMT_TEST_S3_ENDPOINT;
  it.skipIf(!s3Endpoint)(
    'S3（Moto）でも、削除したArtifactのobjectと古い未完了multipart uploadを回収する',
    async () => {
      const client = new S3Client({
        endpoint: s3Endpoint,
        region: 'us-east-1',
        forcePathStyle: true,
        // These values authenticate only to the isolated emulator, never to real storage.
        credentials: { accessKeyId: 'testing', secretAccessKey: 'testing' },
      });
      const bucket = `mmt-gc-test-${Date.now()}`;
      await client.send(new CreateBucketCommand({ Bucket: bucket }));
      const s3 = createS3ArtifactStore({ client, bucket, prefix: 'artifacts' });
      const application = createApplication({
        config: harness.config,
        database: harness.database,
        stores: createArtifactStores({
          filesystem: createFilesystemArtifactStore(harness.artifactDirectory),
          s3,
        }),
      });
      try {
        const fixture = await projectFixture(harness);
        await entity(
          await request(application.app, fixture.basePath, {
            method: 'PATCH',
            cookie: fixture.administrator.cookie,
            body: { artifactBackend: 's3' },
          }),
          200,
        );
        const artifact = await entity<Artifact>(
          await request(application.app, `${fixture.basePath}/artifacts?path=weights.bin`, {
            method: 'PUT',
            cookie: fixture.editor.cookie,
            binary: 'weights on s3',
          }),
        );
        expect(artifact.backend).toBe('s3');
        await entity(
          await request(application.app, `${fixture.basePath}/artifacts/${artifact.id}`, {
            method: 'DELETE',
            cookie: fixture.administrator.cookie,
          }),
          200,
        );
        await s3.multipart!.createMultipart({
          key: `${fixture.project.id}/${randomUUID()}/content`,
          mimeType: 'application/octet-stream',
        });
        const pending = async () =>
          (await client.send(new ListMultipartUploadsCommand({ Bucket: bucket }))).Uploads ?? [];
        expect(await pending()).toHaveLength(1);

        const collection = await application.artifactGarbageCollector.collect(
          new Date(Date.now() + AFTER_GRACE_MS),
        );

        expect(collection).toMatchObject({
          removedBlobs: 1,
          uploads: { abortedOrphanedUploads: 1 },
        });
        expect(await pending()).toEqual([]);
        await expect(
          client.send(
            new HeadObjectCommand({ Bucket: bucket, Key: `artifacts/${artifact.storageKey}` }),
          ),
        ).rejects.toMatchObject({ $metadata: { httpStatusCode: 404 } });
      } finally {
        await client.send(new DeleteBucketCommand({ Bucket: bucket }));
        client.destroy();
      }
    },
  );
});
