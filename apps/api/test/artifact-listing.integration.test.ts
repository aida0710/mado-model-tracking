import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type {
  Artifact,
  ArtifactPage,
  ArtifactTree,
  Model,
  ModelVersion,
  Project,
  Run,
} from '@mmt/contracts';
import { artifactFixture, transferUrl } from './mlflow-artifacts-fixtures.js';
import { createHarness, entity, request, testDatabaseUrl, type Harness } from './harness.js';

type Fixture = Awaited<ReturnType<typeof artifactFixture>>;

async function uploadRunArtifact(
  harness: Harness,
  fixture: Fixture,
  upload: { path: string; body?: string; runId?: string; contentType?: string },
): Promise<Artifact> {
  return entity<Artifact>(
    await request(
      harness.app,
      `${fixture.basePath}/runs/${upload.runId ?? fixture.run.id}/artifacts?path=${encodeURIComponent(upload.path)}`,
      {
        method: 'PUT',
        cookie: fixture.editor.cookie,
        binary: upload.body ?? upload.path,
        headers: { 'Content-Type': upload.contentType ?? 'application/octet-stream' },
      },
    ),
  );
}

async function getPage<T = ArtifactPage>(
  harness: Harness,
  cookie: string,
  url: string,
): Promise<T> {
  return entity<T>(await request(harness.app, url, { cookie }), 200);
}

/** Follows nextCursor until the last page and returns every item in page order. */
async function readAllPages(harness: Harness, cookie: string, url: string): Promise<Artifact[]> {
  const items: Artifact[] = [];
  let cursor: string | undefined;
  do {
    const separator = url.includes('?') ? '&' : '?';
    const page = await getPage(
      harness,
      cookie,
      cursor ? `${url}${separator}cursor=${encodeURIComponent(cursor)}` : url,
    );
    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  return items;
}

/** Rows without blobs: listing reads only the catalog, never the stored content. */
async function insertArtifactRows(
  harness: Harness,
  rows: { projectId: string; runId: string | null; path: string; createdAt: string }[],
): Promise<void> {
  for (const row of rows)
    await harness.database.query(
      `INSERT INTO artifacts(id,project_id,run_id,path,backend,storage_key,mime_type,size,sha256,created_at)
       SELECT id,$1::uuid,$2::uuid,$3,'filesystem',$1::text||'/'||id||'/content','application/octet-stream',1,repeat('0',64),$4
       FROM (SELECT gen_random_uuid() AS id) generated`,
      [row.projectId, row.runId, row.path, row.createdAt],
    );
}

describe.skipIf(!testDatabaseUrl)('Artifactブラウザの一覧・tree・catalog（独立PostgreSQL）', () => {
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

  it('同じpathへ3回保存すると、latestは最新の1件、allは3件を新しい順に返す', async () => {
    const fixture = await artifactFixture(harness);
    const saved: Artifact[] = [];
    for (const body of ['first', 'second', 'third'])
      saved.push(await uploadRunArtifact(harness, fixture, { path: 'eval/result.json', body }));
    const runArtifacts = `${fixture.basePath}/runs/${fixture.run.id}/artifacts`;
    const latest = await getPage(harness, fixture.viewer.cookie, runArtifacts);
    expect(latest.items.map((item) => item.id)).toEqual([saved[2]!.id]);
    expect(latest.nextCursor).toBeUndefined();
    const all = await getPage(harness, fixture.viewer.cookie, `${runArtifacts}?versions=all`);
    expect(all.items.map((item) => item.id)).toEqual(saved.map((item) => item.id).reverse());
  });

  it('MLflowで上書きしたpathは、後からnativeで保存してもmapping先を最新として返す', async () => {
    const fixture = await artifactFixture(harness);
    await uploadRunArtifact(harness, fixture, { path: 'worker.bin', body: 'native first' });
    const url = transferUrl(fixture.mlflowPath, fixture.runRoot, 'worker.bin');
    await entity(
      await request(fixture.app, url, {
        method: 'PUT',
        cookie: fixture.editor.cookie,
        binary: 'SDK mapped',
      }),
      200,
    );
    const later = await uploadRunArtifact(harness, fixture, {
      path: 'worker.bin',
      body: 'later native',
    });
    const latest = await getPage(
      harness,
      fixture.viewer.cookie,
      `${fixture.basePath}/runs/${fixture.run.id}/artifacts`,
    );
    expect(latest.items).toHaveLength(1);
    expect(latest.items[0]!.size).toBe(Buffer.byteLength('SDK mapped'));
    expect(latest.items[0]!.id).not.toBe(later.id);
    // The MLflow list goes through the same rule and serves the same Artifact.
    expect(await (await request(fixture.app, url, { cookie: fixture.viewer.cookie })).text()).toBe(
      'SDK mapped',
    );
  });

  it('treeはprefixの直下のディレクトリと、その下の最新版の件数・合計サイズを返す', async () => {
    const fixture = await artifactFixture(harness);
    for (const [path, body] of [
      ['audio/a.wav', 'aaaa'],
      ['audio/a.wav', 'aaaaaa'],
      ['audio/speaker1/b.wav', 'bb'],
      ['audio/speaker2/c/d.wav', 'ccc'],
      ['audio.txt', 'x'],
      ['notes.txt', 'note'],
      ['audio_backup/e.wav', 'e'],
    ] as const)
      await uploadRunArtifact(harness, fixture, { path, body });
    const treeUrl = `${fixture.basePath}/runs/${fixture.run.id}/artifacts/tree`;
    const root = await getPage<ArtifactTree>(harness, fixture.viewer.cookie, treeUrl);
    expect(root).toEqual({
      prefix: '',
      directories: [
        { prefix: 'audio/', fileCount: 3, totalSize: 6 + 2 + 3 },
        { prefix: 'audio_backup/', fileCount: 1, totalSize: 1 },
      ],
      directoriesTruncated: false,
      fileCount: 2,
      totalSize: 1 + 4,
    });
    // The prefix is a directory with or without the trailing slash, and only its direct children appear.
    const audio = await getPage<ArtifactTree>(
      harness,
      fixture.viewer.cookie,
      `${treeUrl}?prefix=audio`,
    );
    expect(audio).toEqual({
      prefix: 'audio/',
      directories: [
        { prefix: 'audio/speaker1/', fileCount: 1, totalSize: 2 },
        { prefix: 'audio/speaker2/', fileCount: 1, totalSize: 3 },
      ],
      directoriesTruncated: false,
      fileCount: 1,
      totalSize: 6,
    });
    const directFiles = await getPage(
      harness,
      fixture.viewer.cookie,
      `${fixture.basePath}/runs/${fixture.run.id}/artifacts?prefix=audio/&delimiter=/`,
    );
    expect(directFiles.items.map((item) => item.path)).toEqual(['audio/a.wav']);
    const recursive = await getPage(
      harness,
      fixture.viewer.cookie,
      `${fixture.basePath}/runs/${fixture.run.id}/artifacts?prefix=audio/`,
    );
    expect(recursive.items.map((item) => item.path)).toEqual([
      'audio/a.wav',
      'audio/speaker1/b.wav',
      'audio/speaker2/c/d.wav',
    ]);
  });

  it('prefixの%と_は文字として扱い、ほかのpathに一致させない', async () => {
    const fixture = await artifactFixture(harness);
    await uploadRunArtifact(harness, fixture, { path: 'a_b/x.txt' });
    await uploadRunArtifact(harness, fixture, { path: 'acb/y.txt' });
    await uploadRunArtifact(harness, fixture, { path: '100%/z.txt' });
    await uploadRunArtifact(harness, fixture, { path: '1000/w.txt' });
    const list = `${fixture.basePath}/runs/${fixture.run.id}/artifacts`;
    expect(
      (await getPage(harness, fixture.viewer.cookie, `${list}?prefix=a_b/`)).items.map(
        (item) => item.path,
      ),
    ).toEqual(['a_b/x.txt']);
    expect(
      (
        await getPage(
          harness,
          fixture.viewer.cookie,
          `${list}?prefix=${encodeURIComponent('100%')}`,
        )
      ).items.map((item) => item.path),
    ).toEqual(['100%/z.txt']);
  });

  it('Runの一覧はcursorで重複・欠落なく全件を辿れ、同じcreated_atの境界はIDで分ける', async () => {
    const fixture = await artifactFixture(harness);
    const tiedTimestamp = '2026-10-08T00:00:00.123456Z';
    const rows = [];
    for (let index = 0; index < 23; index += 1)
      for (let version = 0; version < 3; version += 1)
        rows.push({
          projectId: fixture.project.id,
          runId: fixture.run.id,
          path: `files/${String(index).padStart(2, '0')}.bin`,
          createdAt: tiedTimestamp,
        });
    await insertArtifactRows(harness, rows);
    const { rows: stored } = await harness.database.query<{ id: string; path: string }>(
      `SELECT id,path FROM artifacts WHERE run_id=$1 ORDER BY path COLLATE "C",id DESC`,
      [fixture.run.id],
    );
    const list = `${fixture.basePath}/runs/${fixture.run.id}/artifacts`;
    const all = await readAllPages(harness, fixture.viewer.cookie, `${list}?versions=all&limit=7`);
    expect(all.map((item) => item.id)).toEqual(stored.map((row) => row.id));
    // With tied timestamps the highest id is the latest version of each path.
    const latest = await readAllPages(harness, fixture.viewer.cookie, `${list}?limit=4`);
    const firstPerPath = stored.filter(
      (row, index) => index === 0 || stored[index - 1]!.path !== row.path,
    );
    expect(latest.map((item) => item.id)).toEqual(firstPerPath.map((row) => row.id));
  });

  it('Project catalogは新しい順のcursorで全件を辿れ、同じcreated_atの境界はIDで分ける', async () => {
    const fixture = await artifactFixture(harness);
    const rows = [];
    for (let index = 0; index < 17; index += 1)
      rows.push({
        projectId: fixture.project.id,
        runId: index % 2 ? fixture.run.id : null,
        path: `catalog/${index}.bin`,
        createdAt: index < 10 ? '2026-10-08T00:00:00.000001Z' : '2026-10-08T00:00:01Z',
      });
    await insertArtifactRows(harness, rows);
    const { rows: stored } = await harness.database.query<{ id: string }>(
      'SELECT id FROM artifacts WHERE project_id=$1 ORDER BY created_at DESC,id DESC',
      [fixture.project.id],
    );
    const items = await readAllPages(
      harness,
      fixture.viewer.cookie,
      `${fixture.basePath}/artifacts?limit=3`,
    );
    expect(items.map((item) => item.id)).toEqual(stored.map((row) => row.id));
  });

  it('Project catalogをMIME種別・Run・モデル版・最新版だけで絞り込める', async () => {
    const fixture = await artifactFixture(harness);
    const wav = await uploadRunArtifact(harness, fixture, {
      path: 'audio/a.wav',
      contentType: 'audio/wav',
    });
    const text = await uploadRunArtifact(harness, fixture, {
      path: 'notes.txt',
      contentType: 'text/plain; charset=utf-8',
    });
    const model = await entity<Model>(
      await request(harness.app, `${fixture.basePath}/models`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: { name: 'Listing Model', family: 'qwen3' },
      }),
    );
    const weights = await entity<Artifact>(
      await request(harness.app, `${fixture.basePath}/artifacts?path=weights.bin`, {
        method: 'PUT',
        cookie: fixture.editor.cookie,
        binary: 'weights',
        headers: { 'Content-Type': 'application/octet-stream' },
      }),
    );
    const version = await entity<ModelVersion>(
      await request(harness.app, `${fixture.basePath}/models/${model.id}/versions`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: { version: 'v1', artifactId: weights.id },
      }),
    );
    const inference = await entity<Run>(
      await request(harness.app, `${fixture.basePath}/runs`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: {
          experimentId: fixture.experiment.id,
          name: 'Inference',
          kind: 'inference',
          modelVersionId: version.id,
        },
      }),
    );
    const output = await uploadRunArtifact(harness, fixture, {
      path: 'out/pred.wav',
      runId: inference.id,
      contentType: 'audio/wav',
    });
    const replaced = await uploadRunArtifact(harness, fixture, {
      path: 'out/pred.wav',
      runId: inference.id,
      contentType: 'audio/wav',
    });
    const catalog = `${fixture.basePath}/artifacts`;
    const ids = async (query: string) =>
      (await getPage(harness, fixture.viewer.cookie, `${catalog}?${query}`)).items
        .map((item) => item.id)
        .sort();
    expect(await ids('mimeType=audio/*')).toEqual([wav.id, output.id, replaced.id].sort());
    expect(await ids('mimeType=text/plain')).toEqual([text.id]);
    expect(await ids(`runId=${fixture.run.id}`)).toEqual([wav.id, text.id].sort());
    expect(await ids(`modelVersionId=${version.id}`)).toEqual(
      [weights.id, output.id, replaced.id].sort(),
    );
    expect(await ids(`modelVersionId=${version.id}&versions=latest`)).toEqual(
      [weights.id, replaced.id].sort(),
    );
    expect(
      (
        await request(harness.app, `${catalog}?mimeType=${encodeURIComponent('audio')}`, {
          cookie: fixture.viewer.cookie,
        })
      ).status,
    ).toBe(422);
  });

  it('他Projectと権限のない利用者には見えず、不正なcursorは400で拒否する', async () => {
    const fixture = await artifactFixture(harness);
    await uploadRunArtifact(harness, fixture, { path: 'private/a.txt' });
    const other = await entity<Project>(
      await request(harness.app, '/api/projects', {
        method: 'POST',
        cookie: fixture.administrator.cookie,
        body: { name: 'Other Listing Project' },
      }),
    );
    const runList = `${fixture.basePath}/runs/${fixture.run.id}/artifacts`;
    for (const url of [runList, `${runList}/tree`, `${fixture.basePath}/artifacts`])
      expect((await request(harness.app, url, { cookie: fixture.outsider.cookie })).status).toBe(
        403,
      );
    // The Run belongs to another Project, so the other Project's path cannot list it.
    for (const url of [
      `/api/projects/${other.id}/runs/${fixture.run.id}/artifacts`,
      `/api/projects/${other.id}/runs/${fixture.run.id}/artifacts/tree`,
    ])
      expect(
        (await request(harness.app, url, { cookie: fixture.administrator.cookie })).status,
      ).toBe(404);
    const otherCatalog = await getPage(
      harness,
      fixture.administrator.cookie,
      `/api/projects/${other.id}/artifacts?runId=${fixture.run.id}`,
    );
    expect(otherCatalog.items).toEqual([]);
    const catalogCursor = Buffer.from(
      JSON.stringify({
        kind: 'catalog',
        createdAt: '2026-10-08T00:00:00.000000Z',
        id: fixture.run.id,
      }),
    ).toString('base64url');
    for (const cursor of ['not-a-cursor', catalogCursor]) {
      const response = await request(harness.app, `${runList}?cursor=${cursor}`, {
        cookie: fixture.viewer.cookie,
      });
      expect(response.status).toBe(400);
      expect(((await response.json()) as { code: string }).code).toBe('invalid_cursor');
    }
  });
});
