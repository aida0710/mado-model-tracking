import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type {
  Artifact,
  ComputeTarget,
  Dataset,
  DatasetVersion,
  DatasetVersionFilePage,
  Job,
  Run,
  WorkerJob,
} from '@mmt/contracts';
import { DEFAULT_DATASET_CACHE_MAX_BYTES } from '@mmt/contracts';
import { executionFixture } from './fixtures.js';
import { createHarness, entity, request, testDatabaseUrl, type Harness } from './harness.js';

type Fixture = Awaited<ReturnType<typeof executionFixture>>;

describe.skipIf(!testDatabaseUrl)('workerによる入力Datasetの取得設定（独立PostgreSQL）', () => {
  let harness: Harness;
  let fixture: Fixture;
  beforeAll(async () => {
    harness = await createHarness();
  });
  beforeEach(async () => {
    await harness.reset();
    fixture = await executionFixture(harness);
  });
  afterAll(async () => {
    await harness?.close();
  });

  function patchTarget(body: Record<string, unknown>, cookie = fixture.administrator.cookie) {
    return request(harness.app, `/api/targets/${fixture.target.id}`, {
      method: 'PATCH',
      cookie,
      body,
    });
  }

  async function mintWorkerToken(scopes: string[]): Promise<string> {
    return (
      await entity<{ token: string }>(
        await request(harness.app, '/api/tokens', {
          method: 'POST',
          cookie: fixture.administrator.cookie,
          body: {
            name: `Dataset worker ${scopes.join(' ')}`,
            kind: 'service',
            projectId: fixture.project.id,
            scopes,
          },
        }),
      )
    ).token;
  }

  async function artifactsVersion(): Promise<{ version: DatasetVersion; clip: Artifact }> {
    const dataset = await entity<Dataset>(
      await request(harness.app, `${fixture.basePath}/datasets`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: { name: 'speech-eval', namespace: 'audio' },
      }),
    );
    const clip = await entity<Artifact>(
      await request(
        harness.app,
        `${fixture.basePath}/artifacts?path=${encodeURIComponent('upload/0001.wav')}`,
        {
          method: 'PUT',
          cookie: fixture.editor.cookie,
          binary: 'RIFF-0001',
          headers: { 'Content-Type': 'audio/wav' },
        },
      ),
    );
    const version = await entity<DatasetVersion>(
      await request(harness.app, `${fixture.basePath}/datasets/${dataset.id}/versions`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: {
          version: 'v1',
          content: { kind: 'artifacts', files: [{ path: 'clips/0001.wav', artifactId: clip.id }] },
        },
      }),
    );
    return { version, clip };
  }

  async function referenceVersion(): Promise<DatasetVersion> {
    const dataset = await entity<Dataset>(
      await request(harness.app, `${fixture.basePath}/datasets`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: { name: 'speech-reference', namespace: 'audio' },
      }),
    );
    return entity<DatasetVersion>(
      await request(harness.app, `${fixture.basePath}/datasets/${dataset.id}/versions`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: { version: 'v1', uri: 's3://corpus/eval/', digest: 'etag-1' },
      }),
    );
  }

  async function queueJob(inputDatasetVersionIds: string[], gpuIds: string[] = []): Promise<Job> {
    const run = await entity<Run>(
      await request(harness.app, `${fixture.basePath}/runs`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: {
          experimentId: fixture.experiment.id,
          name: 'Evaluation with datasets',
          kind: 'inference',
          modelVersionId: fixture.modelVersion.id,
          codeVersionId: fixture.codeVersion.id,
          inputDatasetVersionIds,
        },
      }),
    );
    return entity<Job>(
      await request(harness.app, `${fixture.basePath}/jobs`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: { runId: run.id, targetId: fixture.target.id, gpuIds },
      }),
    );
  }

  async function claim(token: string): Promise<WorkerJob> {
    const claimed = await entity<{ item: WorkerJob | null }>(
      await request(harness.app, '/api/worker/claim', {
        method: 'POST',
        token,
        body: { workerId: 'dataset-worker' },
      }),
      200,
    );
    expect(claimed.item).not.toBeNull();
    return claimed.item!;
  }

  it('targetは既定でrelay・100GiBになり、全体管理者だけが変更でき、不正な値は422', async () => {
    expect(fixture.target).toMatchObject({
      datasetTransfer: 'relay',
      datasetCacheMaxBytes: DEFAULT_DATASET_CACHE_MAX_BYTES,
    });
    const updated = await entity<ComputeTarget>(
      await patchTarget({ datasetTransfer: 'direct', datasetCacheMaxBytes: 5 * 1024 ** 3 }),
      200,
    );
    expect(updated).toMatchObject({
      datasetTransfer: 'direct',
      datasetCacheMaxBytes: 5 * 1024 ** 3,
    });
    expect((await patchTarget({ datasetTransfer: 'relay' }, fixture.editor.cookie)).status).toBe(
      403,
    );
    expect((await patchTarget({ datasetTransfer: 'ftp' })).status).toBe(422);
    expect((await patchTarget({ datasetCacheMaxBytes: 0 })).status).toBe(422);
    // A bigint column must come back as a number, also from the list.
    const targets = await entity<{ items: ComputeTarget[] }>(
      await request(harness.app, '/api/targets', { cookie: fixture.viewer.cookie }),
      200,
    );
    expect(
      targets.items.find((target) => target.id === fixture.target.id)?.datasetCacheMaxBytes,
    ).toBe(5 * 1024 ** 3);
  });

  it('未完了のJobが参照中のtargetでは転送方式とcache上限の変更を409で拒否し、有効切替は許す', async () => {
    await queueJob([]);
    const transfer = await patchTarget({ datasetTransfer: 'direct' });
    expect(transfer.status).toBe(409);
    expect((await patchTarget({ datasetCacheMaxBytes: 1024 ** 3 })).status).toBe(409);
    // Sending the unchanged values is not a change.
    expect(
      (
        await patchTarget({
          datasetTransfer: 'relay',
          datasetCacheMaxBytes: DEFAULT_DATASET_CACHE_MAX_BYTES,
          enabled: false,
        })
      ).status,
    ).toBe(200);
  });

  it('claimの入力DatasetVersionにcontentKind・digest・fileCountが入り、worker tokenとJob tokenでファイルを読める', async () => {
    const { version, clip } = await artifactsVersion();
    const reference = await referenceVersion();
    await queueJob([version.id, reference.id]);
    const workerToken = await mintWorkerToken(['worker:execute', 'read']);
    const claimed = await claim(workerToken);

    expect(claimed.target).toMatchObject({
      datasetTransfer: 'relay',
      datasetCacheMaxBytes: DEFAULT_DATASET_CACHE_MAX_BYTES,
    });
    expect(claimed.inputDatasets.map((dataset) => dataset.id)).toEqual([version.id, reference.id]);
    expect(claimed.inputDatasets[0]).toMatchObject({
      contentKind: 'artifacts',
      digest: version.digest,
      fileCount: 1,
      datasetId: version.datasetId,
      uri: `mmt-dataset://${version.id}`,
    });
    expect(claimed.inputDatasets[1]).toMatchObject({
      contentKind: 'reference',
      digest: 'etag-1',
      fileCount: null,
      uri: 's3://corpus/eval/',
    });

    const filesPath = `${fixture.basePath}/datasets/${version.datasetId}/versions/${version.id}/files?limit=1000`;
    for (const token of [workerToken, claimed.jobToken!]) {
      const page = await entity<DatasetVersionFilePage>(
        await request(harness.app, filesPath, { token }),
        200,
      );
      expect(page.items).toEqual([
        expect.objectContaining({ path: 'clips/0001.wav', artifactId: clip.id }),
      ]);
    }
    // 'direct' transfer: the target reads the content with the Job token.
    const content = await request(harness.app, `${fixture.basePath}/artifacts/${clip.id}/content`, {
      token: claimed.jobToken!,
    });
    expect(content.status).toBe(200);
    expect(await content.text()).toBe('RIFF-0001');
    // The files API needs the `read` scope, which docs/worker.md lists for worker tokens.
    const withoutRead = await mintWorkerToken(['worker:execute']);
    expect((await request(harness.app, filesPath, { token: withoutRead })).status).toBe(403);
  });

  it('取得に失敗して開始前にfailedで完了したJobはGPU予約を解放する', async () => {
    const { version } = await artifactsVersion();
    await queueJob([version.id], ['0']);
    const workerToken = await mintWorkerToken(['worker:execute', 'read']);
    const claimed = await claim(workerToken);
    await queueJob([version.id], ['0']);
    // The second Job waits for GPU 0.
    expect(
      (
        await entity<{ item: WorkerJob | null }>(
          await request(harness.app, '/api/worker/claim', {
            method: 'POST',
            token: workerToken,
            body: { workerId: 'dataset-worker', activeJobIds: [claimed.job.id] },
          }),
          200,
        )
      ).item,
    ).toBeNull();
    const completed = await request(harness.app, `/api/worker/jobs/${claimed.job.id}/complete`, {
      method: 'POST',
      token: workerToken,
      body: {
        leaseId: claimed.job.leaseId,
        status: 'failed',
        error: 'Input dataset could not be prepared on the target: sha256 mismatch',
      },
    });
    expect(completed.status).toBe(200);
    const next = await claim(workerToken);
    expect(next.job.id).not.toBe(claimed.job.id);
    expect(next.job.gpuIds).toEqual(['0']);
  });
});
