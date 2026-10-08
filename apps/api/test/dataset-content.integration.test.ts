import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type {
  Artifact,
  ArtifactTree,
  Dataset,
  DatasetVersion,
  DatasetVersionFilePage,
  LineageGraph,
  Project,
  Run,
} from '@mmt/contracts';
import { datasetManifestDigest } from '../src/domain/datasetManifestDigest.js';
import { projectFixture } from './fixtures.js';
import { createHarness, entity, request, testDatabaseUrl, type Harness } from './harness.js';
import { trackingClient } from './mlflow-tracking-fixtures.js';

type Fixture = Awaited<ReturnType<typeof projectFixture>>;

const sha256 = (body: string) => createHash('sha256').update(body).digest('hex');

describe.skipIf(!testDatabaseUrl)('Artifactを本体とするDatasetVersion（独立PostgreSQL）', () => {
  let harness: Harness;
  let fixture: Fixture;
  let dataset: Dataset;
  beforeAll(async () => {
    harness = await createHarness();
  });
  beforeEach(async () => {
    await harness.reset();
    fixture = await projectFixture(harness);
    dataset = await entity<Dataset>(
      await request(harness.app, `${fixture.basePath}/datasets`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: { name: 'speech', namespace: 'audio' },
      }),
    );
  });
  afterAll(async () => {
    await harness?.close();
  });

  const versionsPath = () => `${fixture.basePath}/datasets/${dataset.id}/versions`;

  async function uploadArtifact(
    upload: { path: string; body: string; runId?: string; basePath?: string; cookie?: string },
  ): Promise<Artifact> {
    const basePath = upload.basePath ?? fixture.basePath;
    const location = upload.runId ? `${basePath}/runs/${upload.runId}/artifacts` : `${basePath}/artifacts`;
    return entity<Artifact>(
      await request(harness.app, `${location}?path=${encodeURIComponent(upload.path)}`, {
        method: 'PUT',
        cookie: upload.cookie ?? fixture.editor.cookie,
        binary: upload.body,
        headers: { 'Content-Type': upload.path.endsWith('.wav') ? 'audio/wav' : 'text/plain' },
      }),
    );
  }

  function createVersion(body: unknown, cookie = fixture.editor.cookie) {
    return request(harness.app, versionsPath(), { method: 'POST', cookie, body });
  }

  async function createRun(name: string): Promise<Run> {
    return entity<Run>(
      await request(harness.app, `${fixture.basePath}/runs`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: { experimentId: fixture.experiment.id, name, kind: 'processing' },
      }),
    );
  }

  async function readFiles(version: DatasetVersion, query = ''): Promise<DatasetVersionFilePage> {
    return entity<DatasetVersionFilePage>(
      await request(harness.app, `${versionsPath()}/${version.id}/files${query}`, {
        cookie: fixture.viewer.cookie,
      }),
      200,
    );
  }

  it('files指定の版はサーバーがuri・digest・件数を決め、ファイル一覧とtreeで読める', async () => {
    const clip = await uploadArtifact({ path: 'upload/a.wav', body: 'RIFF-a' });
    const transcript = await uploadArtifact({ path: 'upload/a.txt', body: 'hello' });
    const response = await createVersion({
      version: 'v1',
      metadata: { language: 'ja' },
      content: {
        kind: 'artifacts',
        files: [
          { path: 'train/a.wav', artifactId: clip.id },
          { path: 'train/a.txt', artifactId: transcript.id },
          { path: 'README.txt', artifactId: transcript.id },
        ],
      },
    });
    const version = await entity<DatasetVersion>(response);
    expect(version).toMatchObject({
      version: 'v1',
      uri: `mmt-dataset://${version.id}`,
      contentKind: 'artifacts',
      fileCount: 3,
      totalSize: 'RIFF-a'.length + 2 * 'hello'.length,
      digest: datasetManifestDigest([
        { path: 'README.txt', sha256: sha256('hello'), size: 5 },
        { path: 'train/a.txt', sha256: sha256('hello'), size: 5 },
        { path: 'train/a.wav', sha256: sha256('RIFF-a'), size: 6 },
      ]),
    });
    expect((await readFiles(version)).items).toEqual([
      { path: 'README.txt', artifactId: transcript.id, size: 5, sha256: sha256('hello'), mimeType: 'text/plain' },
      { path: 'train/a.txt', artifactId: transcript.id, size: 5, sha256: sha256('hello'), mimeType: 'text/plain' },
      { path: 'train/a.wav', artifactId: clip.id, size: 6, sha256: sha256('RIFF-a'), mimeType: 'audio/wav' },
    ]);
    expect((await readFiles(version, '?prefix=train&delimiter=/&limit=1')).nextCursor).toBeDefined();
    const firstPage = await readFiles(version, '?limit=2');
    const secondPage = await readFiles(version, `?limit=2&cursor=${firstPage.nextCursor}`);
    expect([...firstPage.items, ...secondPage.items].map((file) => file.path)).toEqual([
      'README.txt',
      'train/a.txt',
      'train/a.wav',
    ]);
    expect(secondPage.nextCursor).toBeUndefined();
    const tree = await entity<ArtifactTree>(
      await request(harness.app, `${versionsPath()}/${version.id}/files/tree`, {
        cookie: fixture.viewer.cookie,
      }),
      200,
    );
    expect(tree).toEqual({
      prefix: '',
      directories: [{ prefix: 'train/', fileCount: 2, totalSize: 11 }],
      directoriesTruncated: false,
      fileCount: 1,
      totalSize: 5,
    });
  });

  it('files付きの版は不変で、同じversionの再作成は409になり、files・digest・件数は変わらない', async () => {
    const first = await uploadArtifact({ path: 'one.txt', body: 'one' });
    const second = await uploadArtifact({ path: 'two.txt', body: 'two' });
    const version = await entity<DatasetVersion>(
      await createVersion({
        version: 'v1',
        content: { kind: 'artifacts', files: [{ path: 'one.txt', artifactId: first.id }] },
      }),
    );
    const again = await createVersion({
      version: 'v1',
      content: { kind: 'artifacts', files: [{ path: 'two.txt', artifactId: second.id }] },
    });
    expect(again.status).toBe(409);
    await expect(
      harness.database.query('UPDATE dataset_version_files SET size=0 WHERE dataset_version_id=$1', [
        version.id,
      ]),
    ).rejects.toThrow(/immutable/);
    await expect(
      harness.database.query('UPDATE dataset_versions SET file_count=0 WHERE id=$1', [version.id]),
    ).rejects.toThrow(/immutable/);
    const versions = await entity<{ items: DatasetVersion[] }>(
      await request(harness.app, versionsPath(), { cookie: fixture.viewer.cookie }),
      200,
    );
    expect(versions.items).toEqual([version]);
    expect((await readFiles(version)).items.map((file) => file.artifactId)).toEqual([first.id]);
  });

  it('他ProjectのArtifactを含むと422で、版もファイルも残らない', async () => {
    const own = await uploadArtifact({ path: 'own.txt', body: 'own' });
    const otherProject = await entity<Project>(
      await request(harness.app, '/api/projects', {
        method: 'POST',
        cookie: fixture.administrator.cookie,
        body: { name: 'Other Project' },
      }),
    );
    const foreign = await uploadArtifact({
      path: 'foreign.txt',
      body: 'foreign',
      basePath: `/api/projects/${otherProject.id}`,
      cookie: fixture.administrator.cookie,
    });
    const response = await createVersion({
      version: 'v1',
      content: {
        kind: 'artifacts',
        files: [
          { path: 'own.txt', artifactId: own.id },
          { path: 'foreign.txt', artifactId: foreign.id },
        ],
      },
    });
    expect(response.status).toBe(422);
    expect(((await response.json()) as { code: string }).code).toBe('dataset_artifact_not_found');
    expect((await harness.database.query('SELECT 1 FROM dataset_versions')).rowCount).toBe(0);
    expect((await harness.database.query('SELECT 1 FROM dataset_version_files')).rowCount).toBe(0);
  });

  it('クライアントのdigestがファイル一覧から計算した値と違えば422、一致すれば受け付ける', async () => {
    const artifact = await uploadArtifact({ path: 'a.txt', body: 'a' });
    const content = { kind: 'artifacts', files: [{ path: 'a.txt', artifactId: artifact.id }] };
    const expected = datasetManifestDigest([{ path: 'a.txt', sha256: sha256('a'), size: 1 }]);
    const mismatch = await createVersion({ version: 'v1', digest: `${expected}0`, content });
    expect(mismatch.status).toBe(422);
    expect(((await mismatch.json()) as { code: string }).code).toBe('dataset_digest_mismatch');
    const matched = await entity<DatasetVersion>(
      await createVersion({ version: 'v1', digest: expected, content }),
    );
    expect(matched.digest).toBe(expected);
  });

  it('contentとuriは同時に指定できず、重複したpathや安全でないpathは422になる', async () => {
    const artifact = await uploadArtifact({ path: 'a.txt', body: 'a' });
    for (const body of [
      {
        version: 'v1',
        uri: 's3://elsewhere',
        content: { kind: 'artifacts', files: [{ path: 'a.txt', artifactId: artifact.id }] },
      },
      {
        version: 'v1',
        content: {
          kind: 'artifacts',
          files: [
            { path: 'a.txt', artifactId: artifact.id },
            { path: 'a.txt', artifactId: artifact.id },
          ],
        },
      },
      { version: 'v1', content: { kind: 'artifacts', files: [{ path: '../a.txt', artifactId: artifact.id }] } },
      { version: 'v1', content: { kind: 'artifacts', files: [] } },
      { content: { kind: 'artifacts', files: [{ path: 'a\nb', artifactId: artifact.id }] } },
    ])
      expect((await createVersion(body)).status).toBe(422);
  });

  it('fromRunArtifactsはRunのlatestのArtifactだけをprefixからの相対パスで使い、lineageにRunを結ぶ', async () => {
    const run = await createRun('Preprocess');
    await uploadArtifact({ runId: run.id, path: 'outputs/clips/a.wav', body: 'old' });
    const latest = await uploadArtifact({ runId: run.id, path: 'outputs/clips/a.wav', body: 'newer' });
    const other = await uploadArtifact({ runId: run.id, path: 'outputs/clips/b.wav', body: 'b' });
    await uploadArtifact({ runId: run.id, path: 'logs/train.log', body: 'log' });
    const version = await entity<DatasetVersion>(
      await createVersion({
        content: { kind: 'artifacts', fromRunArtifacts: { runId: run.id, prefix: 'outputs' } },
      }),
    );
    expect(version).toMatchObject({ version: '1', sourceRunId: run.id, fileCount: 2, totalSize: 6 });
    expect((await readFiles(version)).items.map(({ path, artifactId }) => ({ path, artifactId }))).toEqual([
      { path: 'clips/a.wav', artifactId: latest.id },
      { path: 'clips/b.wav', artifactId: other.id },
    ]);
    const updatedRun = await entity<Run>(
      await request(harness.app, `${fixture.basePath}/runs/${run.id}`, { cookie: fixture.viewer.cookie }),
      200,
    );
    expect(updatedRun.outputDatasetVersionIds).toEqual([version.id]);
    const graph = await entity<LineageGraph>(
      await request(harness.app, `${fixture.basePath}/lineage`, { cookie: fixture.viewer.cookie }),
      200,
    );
    expect(graph.edges).toContainEqual({ source: run.id, target: version.id, relation: 'output' });
  });

  it('fromRunArtifactsは別のsourceRunId、Artifactの無いprefix、他ProjectのRunを拒否する', async () => {
    const run = await createRun('Preprocess');
    const otherRun = await createRun('Other');
    await uploadArtifact({ runId: run.id, path: 'outputs/a.wav', body: 'a' });
    const mismatch = await createVersion({
      sourceRunId: otherRun.id,
      content: { kind: 'artifacts', fromRunArtifacts: { runId: run.id, prefix: 'outputs/' } },
    });
    expect(mismatch.status).toBe(422);
    expect(((await mismatch.json()) as { code: string }).code).toBe('dataset_source_run_mismatch');
    const empty = await createVersion({
      content: { kind: 'artifacts', fromRunArtifacts: { runId: run.id, prefix: 'missing' } },
    });
    expect(((await empty.json()) as { code: string }).code).toBe('dataset_content_empty');
    const unknown = await createVersion({
      content: {
        kind: 'artifacts',
        fromRunArtifacts: { runId: '00000000-0000-4000-8000-000000000000', prefix: '' },
      },
    });
    expect(unknown.status).toBe(404);
  });

  it('versionを省略した版は整数で採番され、名前付きの版は採番に数えない', async () => {
    const artifact = await uploadArtifact({ path: 'a.txt', body: 'a' });
    const content = { kind: 'artifacts', files: [{ path: 'a.txt', artifactId: artifact.id }] };
    await entity(await createVersion({ version: '2026-10', content }));
    const first = await entity<DatasetVersion>(await createVersion({ content }));
    const second = await entity<DatasetVersion>(await createVersion({ content }));
    expect([first.version, second.version]).toEqual(['1', '2']);
  });

  it('uri・digestで作る版とMLflow log-inputsの版は従来どおりreferenceで、ファイルを持たない', async () => {
    const reference = await entity<DatasetVersion>(
      await createVersion({ version: 'ref', uri: 's3://bucket/speech', digest: 'abc' }),
    );
    expect(reference).toMatchObject({
      uri: 's3://bucket/speech',
      digest: 'abc',
      contentKind: 'reference',
      fileCount: null,
      totalSize: null,
    });
    expect((await readFiles(reference)).items).toEqual([]);
    expect((await createVersion({ version: 'missing-uri', digest: 'abc' })).status).toBe(422);
    const tracking = trackingClient(harness.app, fixture);
    const run = await tracking.createRun();
    await entity(
      await tracking.post('/runs/log-inputs', {
        run_id: run.info.run_id,
        datasets: [
          {
            dataset: { name: 'mlflow-data', digest: 'd1', source_type: 'http', source: '{}' },
            tags: [],
          },
        ],
      }),
      200,
    );
    const stored = await harness.database.query(
      "SELECT content_kind,file_count,total_size FROM dataset_versions WHERE digest='d1'",
    );
    expect(stored.rows).toEqual([{ content_kind: 'reference', file_count: null, total_size: null }]);
  });

  it('viewerは版を作れず読むだけ、Project外の利用者はファイル一覧を読めない', async () => {
    const artifact = await uploadArtifact({ path: 'a.txt', body: 'a' });
    const content = { kind: 'artifacts', files: [{ path: 'a.txt', artifactId: artifact.id }] };
    expect((await createVersion({ version: 'v1', content }, fixture.viewer.cookie)).status).toBe(403);
    const version = await entity<DatasetVersion>(await createVersion({ version: 'v1', content }));
    expect((await readFiles(version)).items).toHaveLength(1);
    const outsider = await request(harness.app, `${versionsPath()}/${version.id}/files`, {
      cookie: fixture.outsider.cookie,
    });
    expect([403, 404]).toContain(outsider.status);
  });

  it('by-digestは同じProjectの保存済みArtifactをsha256とsizeで返し、無ければ404', async () => {
    await uploadArtifact({ path: 'first.wav', body: 'same-bytes' });
    const newest = await uploadArtifact({ path: 'second.wav', body: 'same-bytes' });
    const lookup = (query: string, cookie = fixture.viewer.cookie) =>
      request(harness.app, `${fixture.basePath}/artifacts/by-digest?${query}`, { cookie });
    const found = await entity<Artifact>(
      await lookup(`sha256=${sha256('same-bytes')}&size=${'same-bytes'.length}`),
      200,
    );
    expect(found.id).toBe(newest.id);
    expect((await lookup(`sha256=${sha256('same-bytes')}&size=1`)).status).toBe(404);
    expect((await lookup('sha256=not-hex&size=1')).status).toBe(422);
    expect(
      [403, 404],
    ).toContain(
      (await lookup(`sha256=${sha256('same-bytes')}&size=10`, fixture.outsider.cookie)).status,
    );
  });
});
