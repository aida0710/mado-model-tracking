import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ArtifactService } from '../src/services/artifactService.js';
import {
  artifactFixture,
  artifactServiceDuringWrite,
  createArtifactTestApp,
  proxyListUrl,
  transferUrl,
} from './mlflow-artifacts-fixtures.js';
import { createHarness, entity, request, testDatabaseUrl, type Harness } from './harness.js';

// Exercise a stream larger than the JSON body limit using many bounded chunks.
const STREAM_CHUNK_BYTES = 64 * 1024;
const STREAM_CHUNK_COUNT = 96;

describe.skipIf(!testDatabaseUrl)('MLflow Artifact保存の原子性とstream（隔離PostgreSQL）', () => {
  let harness: Harness;
  beforeEach(async () => {
    harness = await createHarness();
  });
  afterEach(async () => {
    await harness?.close();
  });

  it('storeが保存後に失敗しても旧mappingと旧bytesを保持し、新しいmetadataは残さない', async () => {
    const fixture = await artifactFixture(harness);
    const url = transferUrl(fixture.mlflowPath, fixture.runRoot, 'retry.bin');
    await request(fixture.app, url, {
      method: 'PUT',
      cookie: fixture.editor.cookie,
      binary: 'old bytes',
    });
    const before = (await harness.database.query('SELECT * FROM mlflow_artifact_paths')).rows;
    const failingApp = createArtifactTestApp(
      harness,
      artifactServiceDuringWrite(harness, async () => {
        throw new Error('Simulated storage failure');
      }),
    );
    const failed = await request(failingApp, url, {
      method: 'PUT',
      cookie: fixture.editor.cookie,
      binary: 'failed bytes',
    });
    expect(failed.status).toBe(503);
    expect((await harness.database.query('SELECT * FROM mlflow_artifact_paths')).rows).toEqual(
      before,
    );
    expect((await harness.database.query('SELECT * FROM artifacts')).rows).toHaveLength(1);
    expect(await (await request(fixture.app, url, { cookie: fixture.viewer.cookie })).text()).toBe(
      'old bytes',
    );
    expect(
      (
        await request(fixture.app, url, {
          method: 'PUT',
          cookie: fixture.editor.cookie,
          binary: 'successful retry',
        })
      ).status,
    ).toBe(200);
    expect(await (await request(fixture.app, url, { cookie: fixture.viewer.cookie })).text()).toBe(
      'successful retry',
    );
  });

  it('mappingの保存に失敗するとArtifact INSERTもrollbackし、旧mappingを変更しない', async () => {
    const fixture = await artifactFixture(harness);
    const url = transferUrl(fixture.mlflowPath, fixture.runRoot, 'atomic.bin');
    await request(fixture.app, url, {
      method: 'PUT',
      cookie: fixture.editor.cookie,
      binary: 'old',
    });
    const before = (await harness.database.query('SELECT * FROM mlflow_artifact_paths')).rows;
    await harness.database.query(`
      CREATE FUNCTION reject_test_mapping() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'simulated index write failure'; END $$;
      CREATE TRIGGER reject_test_mapping BEFORE INSERT OR UPDATE ON mlflow_artifact_paths
      FOR EACH ROW EXECUTE FUNCTION reject_test_mapping();
    `);
    expect(
      (
        await request(fixture.app, url, {
          method: 'PUT',
          cookie: fixture.editor.cookie,
          binary: 'new',
        })
      ).status,
    ).toBe(503);
    expect((await harness.database.query('SELECT * FROM mlflow_artifact_paths')).rows).toEqual(
      before,
    );
    expect((await harness.database.query('SELECT * FROM artifacts')).rows).toHaveLength(1);
    expect(await (await request(fixture.app, url, { cookie: fixture.viewer.cookie })).text()).toBe(
      'old',
    );
  });

  it.each(['membership', 'scope', 'revocation', 'expiry'] as const)(
    '転送中に%sが変わったtokenの保存確定を拒否する',
    async (change) => {
      const fixture = await artifactFixture(harness);
      const minted = await entity<{ token: string; item: { id: string } }>(
        await request(harness.app, '/api/tokens', {
          method: 'POST',
          cookie: fixture.editor.cookie,
          body: {
            name: 'Transfer revocation',
            kind: 'personal',
            projectId: fixture.project.id,
            scopes: ['read', 'artifacts:write'],
          },
        }),
      );
      const changes = {
        membership: () =>
          harness.database.query(
            "UPDATE project_members SET role='viewer' WHERE project_id=$1 AND user_id=$2",
            [fixture.project.id, fixture.editor.userId],
          ),
        scope: () =>
          harness.database.query("UPDATE api_tokens SET scopes=ARRAY['read'] WHERE id=$1", [
            minted.item.id,
          ]),
        revocation: () =>
          harness.database.query('UPDATE api_tokens SET revoked_at=now() WHERE id=$1', [
            minted.item.id,
          ]),
        expiry: () =>
          harness.database.query(
            "UPDATE api_tokens SET expires_at=now()-interval '1 second' WHERE id=$1",
            [minted.item.id],
          ),
      };
      const changingApp = createArtifactTestApp(
        harness,
        artifactServiceDuringWrite(harness, async () => {
          await changes[change]();
        }),
      );
      const url = transferUrl(fixture.mlflowPath, fixture.runRoot, 'uncommitted.bin');
      expect(
        (
          await request(changingApp, url, {
            method: 'PUT',
            token: minted.token,
            binary: 'unauthorized bytes',
          })
        ).status,
      ).toBe(['revocation', 'expiry'].includes(change) ? 401 : 403);
      expect(
        (await harness.database.query('SELECT * FROM mlflow_artifact_paths')).rows,
      ).toHaveLength(0);
      expect((await harness.database.query('SELECT * FROM artifacts')).rows).toHaveLength(0);
      expect((await request(fixture.app, url, { cookie: fixture.viewer.cookie })).status).toBe(404);
    },
  );

  it.each(['run', 'experiment', 'model', 'modelのsource Run'] as const)(
    '転送中に%s ownerがsoftdeleteされたら保存確定を拒否する',
    async (kind) => {
      const fixture = await artifactFixture(harness);
      const model = await fixture.loggedModel();
      const changingApp = createArtifactTestApp(
        harness,
        artifactServiceDuringWrite(harness, async () => {
          if (kind === 'run' || kind === 'modelのsource Run')
            await harness.database.query("UPDATE runs SET lifecycle_stage='deleted' WHERE id=$1", [
              fixture.run.id,
            ]);
          if (kind === 'experiment')
            await harness.database.query(
              "UPDATE experiments SET lifecycle_stage='deleted' WHERE id=$1",
              [fixture.experiment.id],
            );
          if (kind === 'model')
            await harness.database.query(
              'UPDATE mlflow_logged_models SET deleted_at=now() WHERE id=$1',
              [model.id],
            );
        }),
      );
      const root = kind === 'model' || kind === 'modelのsource Run' ? model.root : fixture.runRoot;
      expect(
        (
          await request(changingApp, transferUrl(fixture.mlflowPath, root, 'uncommitted.bin'), {
            method: 'PUT',
            cookie: fixture.editor.cookie,
            binary: 'deleted owner',
          })
        ).status,
      ).toBe(404);
      expect(
        (await harness.database.query('SELECT * FROM mlflow_artifact_paths')).rows,
      ).toHaveLength(0);
      expect((await harness.database.query('SELECT * FROM artifacts')).rows).toHaveLength(0);
    },
  );

  it('転送中にmodelがREADYになったら既存bytesを固定し、新しいArtifactをrollbackする', async () => {
    const fixture = await artifactFixture(harness);
    const model = await fixture.loggedModel();
    const url = transferUrl(fixture.mlflowPath, model.root, 'model.pkl');
    await request(fixture.app, url, {
      method: 'PUT',
      cookie: fixture.editor.cookie,
      binary: 'immutable model',
    });
    const before = (await harness.database.query('SELECT * FROM mlflow_artifact_paths')).rows;
    const changingApp = createArtifactTestApp(
      harness,
      artifactServiceDuringWrite(harness, async () => {
        await harness.database.query("UPDATE mlflow_logged_models SET status='READY' WHERE id=$1", [
          model.id,
        ]);
      }),
    );
    expect(
      (
        await request(changingApp, url, {
          method: 'PUT',
          cookie: fixture.editor.cookie,
          binary: 'late overwrite',
        })
      ).status,
    ).toBe(409);
    expect((await harness.database.query('SELECT * FROM mlflow_artifact_paths')).rows).toEqual(
      before,
    );
    expect((await harness.database.query('SELECT * FROM artifacts')).rows).toHaveLength(1);
    expect(await (await request(fixture.app, url, { cookie: fixture.viewer.cookie })).text()).toBe(
      'immutable model',
    );
  });

  it('6MiBのbodyを生成中にstoreへ渡し、正確なsizeとhashで読み出せる', async () => {
    const fixture = await artifactFixture(harness);
    let chunksProduced = 0;
    let streamedBeforeComplete = false;
    const artifacts = new ArtifactService(harness.database, {
      ...harness.stores,
      async put(write) {
        const observedBody = Readable.from(
          (async function* () {
            let firstChunk = true;
            for await (const chunk of write.body) {
              if (firstChunk) streamedBeforeComplete = chunksProduced < STREAM_CHUNK_COUNT;
              firstChunk = false;
              yield chunk;
            }
          })(),
          { objectMode: false },
        );
        return harness.stores.put({ ...write, body: observedBody });
      },
    });
    const app = createArtifactTestApp(harness, artifacts);
    const contents = Buffer.alloc(STREAM_CHUNK_BYTES, 0x61);
    const uploadBody = Readable.from(
      (async function* () {
        for (let index = 0; index < STREAM_CHUNK_COUNT; index++) {
          chunksProduced++;
          yield contents;
        }
      })(),
    );
    const url = transferUrl(fixture.mlflowPath, fixture.runRoot, 'large.bin');
    const upload = new Request(`http://localhost${url}`, {
      method: 'PUT',
      body: Readable.toWeb(uploadBody) as ReadableStream<Uint8Array>,
      duplex: 'half',
      headers: {
        Cookie: fixture.editor.cookie,
        Origin: 'http://127.0.0.1:5182',
        'Content-Type': 'application/octet-stream',
      },
    } as RequestInit & { duplex: 'half' });
    expect((await app.request(upload)).status).toBe(200);
    expect(streamedBeforeComplete).toBe(true);
    const expectedHash = createHash('sha256');
    for (let index = 0; index < STREAM_CHUNK_COUNT; index++) expectedHash.update(contents);
    const download = await request(app, url, { cookie: fixture.viewer.cookie });
    const bytes = Buffer.from(await download.arrayBuffer());
    expect(bytes.byteLength).toBe(STREAM_CHUNK_BYTES * STREAM_CHUNK_COUNT);
    expect(download.headers.get('Content-Length')).toBe(String(bytes.byteLength));
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(expectedHash.digest('hex'));
  });

  it.each(['run', 'model'] as const)(
    '%sの途切れたstreamを成功扱いせず、部分ファイルをmappingへ登録しない',
    async (kind) => {
      const fixture = await artifactFixture(harness);
      const model = kind === 'model' ? await fixture.loggedModel() : null;
      const root = model?.root ?? fixture.runRoot;
      const uploadBody = Readable.from(
        (async function* () {
          yield Buffer.from('partial');
          throw new Error('Simulated disconnected upload');
        })(),
      );
      const url = transferUrl(fixture.mlflowPath, root, model ? 'MLmodel' : 'partial.bin');
      const upload = new Request(`http://localhost${url}`, {
        method: 'PUT',
        body: Readable.toWeb(uploadBody) as ReadableStream<Uint8Array>,
        duplex: 'half',
        headers: { Cookie: fixture.editor.cookie, Origin: 'http://127.0.0.1:5182' },
      } as RequestInit & { duplex: 'half' });
      expect((await fixture.app.request(upload)).status).toBe(503);
      expect((await harness.database.query('SELECT * FROM artifacts')).rows).toHaveLength(0);
      expect(
        await entity(
          await request(fixture.app, proxyListUrl(fixture.mlflowPath, root), {
            cookie: fixture.viewer.cookie,
          }),
          200,
        ),
      ).toEqual({ files: [] });
    },
  );
});
