import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Artifact, Model, ModelVersion } from '@mmt/contracts';
import { createArtifactStores, createFilesystemArtifactStore } from '@mmt/platform';
import { ArtifactService } from '../src/services/artifactService.js';
import { mlflowTrackingRoutes } from '../src/mlflow/tracking/index.js';
import {
  artifactFixture,
  createArtifactTestApp,
  proxyListUrl,
  transferUrl,
} from './mlflow-artifacts-fixtures.js';
import { createHarness, entity, request, testDatabaseUrl, type Harness } from './harness.js';

describe.skipIf(!testDatabaseUrl)('MLflow Artifact転送（隔離PostgreSQL）', () => {
  let harness: Harness;
  beforeEach(async () => {
    harness = await createHarness();
  });
  afterEach(async () => {
    await harness?.close();
  });

  it('同じRunへのモデル出力記録とArtifact保存を同時に行っても全件を保存できる', async () => {
    const fixture = await artifactFixture(harness);
    const model = await fixture.loggedModel();
    fixture.app.route(
      '/api/mlflow/projects/:p',
      mlflowTrackingRoutes({
        database: harness.database,
        runs: harness.services.runs,
        registry: harness.services.registry,
        runCompletion: harness.services.runCompletion,
      }),
    );
    // Several concurrent writes exercise the shared source Run and model lock order.
    const parallelWrites = 6;
    const responses = await Promise.all(
      Array.from({ length: parallelWrites }, (_, index) => [
        request(
          fixture.app,
          transferUrl(fixture.mlflowPath, model.root, `data/part-${index}.bin`),
          {
            method: 'PUT',
            cookie: fixture.editor.cookie,
            binary: `part-${index}`,
          },
        ),
        request(fixture.app, `${fixture.mlflowPath}/api/2.0/mlflow/runs/outputs`, {
          method: 'POST',
          cookie: fixture.editor.cookie,
          body: { run_id: fixture.run.id, models: [{ model_id: model.id, step: index }] },
        }),
      ]).flat(),
    );
    expect(responses.map((response) => response.status)).toEqual(
      Array(parallelWrites * 2).fill(200),
    );
    expect((await harness.database.query('SELECT run_id FROM artifacts')).rows).toEqual(
      Array.from({ length: parallelWrites }, () => ({ run_id: fixture.run.id })),
    );
    expect(
      (await harness.database.query('SELECT model_id FROM mlflow_run_model_outputs')).rows,
    ).toHaveLength(parallelWrites);
  });

  it('空のrun rootと存在しないdirectoryの一覧を返す', async () => {
    const fixture = await artifactFixture(harness);
    expect(
      await entity(
        await request(fixture.app, proxyListUrl(fixture.mlflowPath, fixture.runRoot), {
          cookie: fixture.viewer.cookie,
        }),
        200,
      ),
    ).toEqual({ files: [] });
    expect(
      await entity(
        await request(
          fixture.app,
          `${fixture.mlflowPath}/api/2.0/mlflow/artifacts/list?run_id=${fixture.run.id}`,
          {
            cookie: fixture.viewer.cookie,
          },
        ),
        200,
      ),
    ).toEqual({ root_uri: `mlflow-artifacts:/${fixture.runRoot}`, files: [] });
    expect(
      await entity(
        await request(fixture.app, proxyListUrl(fixture.mlflowPath, `${fixture.runRoot}/empty`), {
          cookie: fixture.viewer.cookie,
        }),
        200,
      ),
    ).toEqual({ files: [] });
  });

  it('SDK形式で日本語pathをPUTし、直下の階層と元のbytesを読み出せる', async () => {
    const fixture = await artifactFixture(harness);
    const path = '日本語/実験 結果.txt';
    const contents = '日本語のファイル\n';
    const url = transferUrl(fixture.mlflowPath, fixture.runRoot, path);
    expect(
      await entity(
        await request(fixture.app, url, {
          method: 'PUT',
          cookie: fixture.editor.cookie,
          binary: contents,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        }),
        200,
      ),
    ).toEqual({});
    expect(
      await entity(
        await request(fixture.app, proxyListUrl(fixture.mlflowPath, fixture.runRoot), {
          cookie: fixture.viewer.cookie,
        }),
        200,
      ),
    ).toEqual({ files: [{ path: '日本語', is_dir: true }] });
    expect(
      await entity(
        await request(fixture.app, proxyListUrl(fixture.mlflowPath, `${fixture.runRoot}/日本語`), {
          cookie: fixture.viewer.cookie,
        }),
        200,
      ),
    ).toEqual({
      files: [
        { path: '実験 結果.txt', is_dir: false, file_size: String(Buffer.byteLength(contents)) },
      ],
    });
    const runListing = await entity(
      await request(
        fixture.app,
        `${fixture.mlflowPath}/api/2.0/mlflow/artifacts/list?run_id=${fixture.run.id}&path=${encodeURIComponent('日本語')}`,
        {
          cookie: fixture.viewer.cookie,
        },
      ),
      200,
    );
    expect(runListing).toEqual({
      root_uri: `mlflow-artifacts:/${fixture.runRoot}`,
      files: [{ path, is_dir: false, file_size: String(Buffer.byteLength(contents)) }],
    });
    const response = await request(fixture.app, url, { cookie: fixture.viewer.cookie });
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Length')).toBe(String(Buffer.byteLength(contents)));
    expect(response.headers.get('Content-Type')).toBe('text/plain; charset=utf-8');
    expect(await response.text()).toBe(contents);
    const artifacts = (await harness.database.query<Artifact>('SELECT * FROM artifacts')).rows;
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]!.path).toBe(path);
  });

  it('空ファイルを保存でき、size=0とRangeの不成立を正確に返す', async () => {
    const fixture = await artifactFixture(harness);
    const url = transferUrl(fixture.mlflowPath, fixture.runRoot, 'empty.bin');
    expect(
      (await request(fixture.app, url, { method: 'PUT', cookie: fixture.editor.cookie })).status,
    ).toBe(200);
    const listing = await entity(
      await request(fixture.app, proxyListUrl(fixture.mlflowPath, fixture.runRoot), {
        cookie: fixture.viewer.cookie,
      }),
      200,
    );
    expect(listing).toEqual({ files: [{ path: 'empty.bin', is_dir: false, file_size: '0' }] });
    const download = await request(fixture.app, url, { cookie: fixture.viewer.cookie });
    expect(download.headers.get('Content-Length')).toBe('0');
    expect((await download.arrayBuffer()).byteLength).toBe(0);
    const ranged = await request(fixture.app, url, {
      cookie: fixture.viewer.cookie,
      headers: { Range: 'bytes=0-0' },
    });
    expect(ranged.status).toBe(416);
    expect(ranged.headers.get('Content-Range')).toBe('bytes */0');
  });

  it('深いdirectoryと記号のあるpathを一覧にし、単一fileの一覧は空にする', async () => {
    const fixture = await artifactFixture(harness);
    for (const path of ['tree/a.bin', 'tree/sub/b.bin', 'tree/sub/c.bin', 'tree/100%_?.bin']) {
      expect(
        (
          await request(fixture.app, transferUrl(fixture.mlflowPath, fixture.runRoot, path), {
            method: 'PUT',
            cookie: fixture.editor.cookie,
            binary: 'abc',
          })
        ).status,
      ).toBe(200);
    }
    expect(
      await entity(
        await request(fixture.app, proxyListUrl(fixture.mlflowPath, `${fixture.runRoot}/tree/`), {
          cookie: fixture.viewer.cookie,
        }),
        200,
      ),
    ).toEqual({
      files: [
        { path: '100%_?.bin', is_dir: false, file_size: '3' },
        { path: 'a.bin', is_dir: false, file_size: '3' },
        { path: 'sub', is_dir: true },
      ],
    });
    expect(
      await entity(
        await request(
          fixture.app,
          proxyListUrl(fixture.mlflowPath, `${fixture.runRoot}/tree/a.bin`),
          {
            cookie: fixture.viewer.cookie,
          },
        ),
        200,
      ),
    ).toEqual({ files: [] });
  });

  it('Rangeの先頭・末尾・中間をstreamし、成立しないRangeは416にする', async () => {
    const fixture = await artifactFixture(harness);
    const url = transferUrl(fixture.mlflowPath, fixture.runRoot, 'bytes.bin');
    await request(fixture.app, url, {
      method: 'PUT',
      cookie: fixture.editor.cookie,
      binary: '0123456789',
    });
    for (const [range, expected, contentRange] of [
      ['bytes=0-2', '012', 'bytes 0-2/10'],
      ['bytes=3-6', '3456', 'bytes 3-6/10'],
      ['bytes=-2', '89', 'bytes 8-9/10'],
      ['bytes=8-', '89', 'bytes 8-9/10'],
    ]) {
      const download = await request(fixture.app, url, {
        cookie: fixture.viewer.cookie,
        headers: { Range: range! },
      });
      expect(download.status).toBe(206);
      expect(download.headers.get('Content-Range')).toBe(contentRange);
      expect(download.headers.get('Content-Length')).toBe(String(expected!.length));
      expect(download.headers.get('Accept-Ranges')).toBe('bytes');
      expect(await download.text()).toBe(expected);
    }
    const invalid = await request(fixture.app, url, {
      cookie: fixture.viewer.cookie,
      headers: { Range: 'bytes=99-100' },
    });
    expect(invalid.status).toBe(416);
    expect(invalid.headers.get('Content-Range')).toBe('bytes */10');
  });

  it('重複uploadで新しいArtifactへmappingを更新し、既存モデル版の参照を保持する', async () => {
    const fixture = await artifactFixture(harness);
    const url = transferUrl(fixture.mlflowPath, fixture.runRoot, 'weights.bin');
    expect(
      (
        await request(fixture.app, url, {
          method: 'PUT',
          cookie: fixture.editor.cookie,
          binary: 'first',
        })
      ).status,
    ).toBe(200);
    const firstId = (
      await harness.database.query<{ artifact_id: string }>(
        'SELECT artifact_id FROM mlflow_artifact_paths',
      )
    ).rows[0]!.artifact_id;
    const model = await entity<Model>(
      await request(harness.app, `${fixture.basePath}/models`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: { name: 'Immutable', family: 'test' },
      }),
    );
    const version = await entity<ModelVersion>(
      await request(harness.app, `${fixture.basePath}/models/${model.id}/versions`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: { version: '1', artifactId: firstId, sourceRunId: fixture.run.id },
      }),
    );
    expect(
      (
        await request(fixture.app, url, {
          method: 'PUT',
          cookie: fixture.editor.cookie,
          binary: 'second version',
        })
      ).status,
    ).toBe(200);
    const secondId = (
      await harness.database.query<{ artifact_id: string }>(
        'SELECT artifact_id FROM mlflow_artifact_paths',
      )
    ).rows[0]!.artifact_id;
    expect(secondId).not.toBe(firstId);
    expect((await harness.database.query('SELECT id FROM artifacts')).rows).toHaveLength(2);
    expect(
      (
        await harness.database.query<{ artifact_id: string }>(
          'SELECT artifact_id FROM model_versions WHERE id=$1',
          [version.id],
        )
      ).rows[0]!.artifact_id,
    ).toBe(firstId);
    expect(await (await request(fixture.app, url, { cookie: fixture.viewer.cookie })).text()).toBe(
      'second version',
    );
    expect(
      await (
        await request(harness.app, `${fixture.basePath}/artifacts/${firstId}/content`, {
          cookie: fixture.viewer.cookie,
        })
      ).text(),
    ).toBe('first');
  });

  it('同じpathへの並行uploadを直列化し、mappingを完全に保存済みの一つへ確定する', async () => {
    const fixture = await artifactFixture(harness);
    const url = transferUrl(fixture.mlflowPath, fixture.runRoot, 'parallel.bin');
    const uploads = await Promise.all(
      ['first upload', 'second upload'].map((binary) =>
        request(fixture.app, url, {
          method: 'PUT',
          cookie: fixture.editor.cookie,
          binary,
        }),
      ),
    );
    expect(uploads.map((upload) => upload.status)).toEqual([200, 200]);
    expect((await harness.database.query('SELECT * FROM mlflow_artifact_paths')).rows).toHaveLength(
      1,
    );
    expect((await harness.database.query('SELECT * FROM artifacts')).rows).toHaveLength(2);
    const download = await request(fixture.app, url, { cookie: fixture.viewer.cookie });
    const bytes = await download.text();
    expect(['first upload', 'second upload']).toContain(bytes);
    expect(download.headers.get('Content-Length')).toBe(String(Buffer.byteLength(bytes)));
  });

  it('fileとdirectoryが衝突するuploadを保存前に拒否する', async () => {
    const fixture = await artifactFixture(harness);
    await request(
      fixture.app,
      transferUrl(fixture.mlflowPath, fixture.runRoot, 'directory/file.bin'),
      {
        method: 'PUT',
        cookie: fixture.editor.cookie,
        binary: 'nested',
      },
    );
    expect(
      (
        await request(fixture.app, transferUrl(fixture.mlflowPath, fixture.runRoot, 'directory'), {
          method: 'PUT',
          cookie: fixture.editor.cookie,
          binary: 'conflict',
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await request(
          fixture.app,
          transferUrl(fixture.mlflowPath, fixture.runRoot, 'directory/file.bin/child'),
          {
            method: 'PUT',
            cookie: fixture.editor.cookie,
            binary: 'conflict',
          },
        )
      ).status,
    ).toBe(409);
    expect((await harness.database.query('SELECT * FROM artifacts')).rows).toHaveLength(1);
  });

  it('PENDING modelへ保存し、正式directories/filesルートとmodel native pathで読める', async () => {
    const fixture = await artifactFixture(harness);
    const model = await fixture.loggedModel();
    const path = 'sub/model.pkl';
    expect(
      (
        await request(fixture.app, transferUrl(fixture.mlflowPath, model.root, path), {
          method: 'PUT',
          cookie: fixture.editor.cookie,
          binary: 'model bytes',
        })
      ).status,
    ).toBe(200);
    const listing = await entity(
      await request(
        fixture.app,
        `${fixture.mlflowPath}/api/2.0/mlflow/logged-models/${model.id}/artifacts/directories?artifact_directory_path=sub`,
        {
          cookie: fixture.viewer.cookie,
        },
      ),
      200,
    );
    expect(listing).toEqual({
      root_uri: `mlflow-artifacts:/${model.root}`,
      files: [{ path, is_dir: false, file_size: '11' }],
    });
    const download = await request(
      fixture.app,
      `${fixture.mlflowPath}/api/2.0/mlflow/logged-models/${model.id}/artifacts/files?artifact_file_path=${encodeURIComponent(path)}`,
      {
        cookie: fixture.viewer.cookie,
      },
    );
    expect(download.status).toBe(200);
    expect(await download.text()).toBe('model bytes');
    const artifact = (
      await harness.database.query<{ path: string; run_id: string | null }>(
        'SELECT path,run_id FROM artifacts',
      )
    ).rows[0]!;
    expect(artifact.path).toBe(`models/${model.id}/${path}`);
    expect(artifact.run_id).toBe(fixture.run.id);
    const nativeListing = await entity<{ items: Artifact[] }>(
      await request(harness.app, `${fixture.basePath}/runs/${fixture.run.id}/artifacts`, {
        cookie: fixture.viewer.cookie,
      }),
      200,
    );
    expect(nativeListing.items[0]!.path).toBe(`models/${model.id}/${path}`);
  });

  it('MLmodelをstream転送し、上限以内のflavorsをmetadataへ保存する', async () => {
    const fixture = await artifactFixture(harness);
    const model = await fixture.loggedModel();
    const contents = 'flavors:\n  sklearn:\n    pickled_model: model.pkl\n';
    const url = transferUrl(fixture.mlflowPath, model.root, 'MLmodel');
    expect(
      (
        await request(fixture.app, url, {
          method: 'PUT',
          cookie: fixture.editor.cookie,
          binary: contents,
        })
      ).status,
    ).toBe(200);
    const metadata = (
      await harness.database.query<{ metadata: unknown }>(
        'SELECT metadata FROM mlflow_logged_models WHERE id=$1',
        [model.id],
      )
    ).rows[0]!.metadata;
    expect(metadata).toEqual({ mlmodel: { flavors: { sklearn: { pickled_model: 'model.pkl' } } } });
    expect(await (await request(fixture.app, url, { cookie: fixture.viewer.cookie })).text()).toBe(
      contents,
    );
  });

  it('source Runなしのmodel Artifactはrun_id=nullでProject一覧から読める', async () => {
    const fixture = await artifactFixture(harness);
    const model = await fixture.loggedModel({ sourceRun: false });
    expect(
      (
        await request(fixture.app, transferUrl(fixture.mlflowPath, model.root, 'model.pkl'), {
          method: 'PUT',
          cookie: fixture.editor.cookie,
          binary: 'standalone model',
        })
      ).status,
    ).toBe(200);
    const catalog = await entity<{ items: Artifact[] }>(
      await request(harness.app, `${fixture.basePath}/artifacts`, {
        cookie: fixture.viewer.cookie,
      }),
      200,
    );
    expect(catalog.items).toHaveLength(1);
    expect(catalog.items[0]!.runId).toBeNull();
    expect(catalog.items[0]!.path).toBe(`models/${model.id}/model.pkl`);
  });

  it('native workerの未mapping Artifactを最新pathで読み、SDK上書き後はmappingを正本にする', async () => {
    const fixture = await artifactFixture(harness);
    for (const bytes of ['native first', 'native latest']) {
      await entity(
        await request(
          harness.app,
          `${fixture.basePath}/runs/${fixture.run.id}/artifacts?path=worker.bin`,
          {
            method: 'PUT',
            cookie: fixture.editor.cookie,
            binary: bytes,
          },
        ),
      );
    }
    const url = transferUrl(fixture.mlflowPath, fixture.runRoot, 'worker.bin');
    expect(await (await request(fixture.app, url, { cookie: fixture.viewer.cookie })).text()).toBe(
      'native latest',
    );
    expect(
      await entity(
        await request(fixture.app, proxyListUrl(fixture.mlflowPath, fixture.runRoot), {
          cookie: fixture.viewer.cookie,
        }),
        200,
      ),
    ).toEqual({ files: [{ path: 'worker.bin', is_dir: false, file_size: '13' }] });
    await entity(
      await request(fixture.app, url, {
        method: 'PUT',
        cookie: fixture.editor.cookie,
        binary: 'SDK mapped',
      }),
      200,
    );
    await entity(
      await request(
        harness.app,
        `${fixture.basePath}/runs/${fixture.run.id}/artifacts?path=worker.bin`,
        {
          method: 'PUT',
          cookie: fixture.editor.cookie,
          binary: 'later native upload',
        },
      ),
    );
    expect(await (await request(fixture.app, url, { cookie: fixture.viewer.cookie })).text()).toBe(
      'SDK mapped',
    );
  });

  it('ProjectのS3選択を既存ArtifactStoresへ渡し、同じbackendでstream read/Rangeを実行する', async () => {
    const fixture = await artifactFixture(harness);
    // This store fixture verifies backend dispatch; it does not claim a real S3 connection.
    const stores = createArtifactStores({
      s3: createFilesystemArtifactStore(harness.artifactDirectory),
    });
    await harness.database.query("UPDATE projects SET artifact_backend='s3' WHERE id=$1", [
      fixture.project.id,
    ]);
    const app = createArtifactTestApp(harness, new ArtifactService(harness.database, stores));
    const url = transferUrl(fixture.mlflowPath, fixture.runRoot, 's3-selected.bin');
    expect(
      (
        await request(app, url, {
          method: 'PUT',
          cookie: fixture.editor.cookie,
          binary: 'backend dispatch',
        })
      ).status,
    ).toBe(200);
    expect(
      (await harness.database.query<{ backend: string }>('SELECT backend FROM artifacts')).rows[0]!
        .backend,
    ).toBe('s3');
    const download = await request(app, url, {
      cookie: fixture.viewer.cookie,
      headers: { Range: 'bytes=0-6' },
    });
    expect(download.status).toBe(206);
    expect(download.headers.get('Content-Length')).toBe('7');
    expect(await download.text()).toBe('backend');
  });

  it('SDKが送った音声のContent-Typeを全体取得・Rangeの206・nativeのinline表示で保つ', async () => {
    const fixture = await artifactFixture(harness);
    const wave = pcmWaveBytes(64);
    // Python's mimetypes reports audio/x-wav for .wav; the official SDK sends that value as is.
    for (const [path, mimeType] of [
      ['audio/sample.wav', 'audio/x-wav'],
      ['audio/sample.flac', 'audio/flac'],
    ] as const) {
      const url = transferUrl(fixture.mlflowPath, fixture.runRoot, path);
      expect(
        (
          await request(fixture.app, url, {
            method: 'PUT',
            cookie: fixture.editor.cookie,
            binary: wave,
            headers: { 'Content-Type': mimeType },
          })
        ).status,
      ).toBe(200);
      const whole = await request(fixture.app, url, { cookie: fixture.viewer.cookie });
      expect(whole.status).toBe(200);
      expect(whole.headers.get('Content-Type')).toBe(mimeType);
      expect(Buffer.from(await whole.arrayBuffer()).equals(wave)).toBe(true);
      const header = await request(fixture.app, url, {
        cookie: fixture.viewer.cookie,
        headers: { Range: 'bytes=0-11' },
      });
      expect(header.status).toBe(206);
      expect(header.headers.get('Content-Type')).toBe(mimeType);
      expect(header.headers.get('Content-Range')).toBe(`bytes 0-11/${wave.length}`);
      expect(Buffer.from(await header.arrayBuffer()).equals(wave.subarray(0, 12))).toBe(true);
    }
    const {
      rows: [stored],
    } = await harness.database.query<{ id: string }>(
      "SELECT id FROM artifacts WHERE path='audio/sample.wav'",
    );
    const nativeUrl = `${fixture.basePath}/artifacts/${stored!.id}/content`;
    const preview = await request(harness.app, nativeUrl, {
      cookie: fixture.viewer.cookie,
      headers: { Range: 'bytes=44-' },
    });
    expect(preview.status).toBe(206);
    expect(preview.headers.get('Content-Type')).toBe('audio/x-wav');
    expect(preview.headers.get('Content-Disposition')).toMatch(/^inline;/);
    expect(preview.headers.get('Content-Range')).toBe(`bytes 44-${wave.length - 1}/${wave.length}`);
  });

  it('汎用のContent-Typeで送った音声は拡張子からaudio/flacとaudio/wavを推定する', async () => {
    const fixture = await artifactFixture(harness);
    // MLflow falls back to application/octet-stream when the client's mimetypes table lacks .flac.
    for (const [path, inferred] of [
      ['fallback/sample.flac', 'audio/flac'],
      ['fallback/sample.wav', 'audio/wav'],
    ] as const) {
      const url = transferUrl(fixture.mlflowPath, fixture.runRoot, path);
      await request(fixture.app, url, {
        method: 'PUT',
        cookie: fixture.editor.cookie,
        binary: pcmWaveBytes(16),
        headers: { 'Content-Type': 'application/octet-stream' },
      });
      const ranged = await request(fixture.app, url, {
        cookie: fixture.viewer.cookie,
        headers: { Range: 'bytes=-4' },
      });
      expect(ranged.status).toBe(206);
      expect(ranged.headers.get('Content-Type')).toBe(inferred);
    }
  });
});

/** A 16-bit mono PCM WAV with a canonical 44-byte header, so Range offsets match real files. */
function pcmWaveBytes(sampleCount: number): Uint8Array<ArrayBuffer> {
  const dataSize = sampleCount * 2;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVEfmt ', 8, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24);
  header.writeUInt32LE(32000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataSize, 40);
  const samples = Buffer.alloc(dataSize);
  for (let index = 0; index < sampleCount; index += 1)
    samples.writeInt16LE(Math.round(Math.sin(index / 4) * 8000), index * 2);
  return new Uint8Array(Buffer.concat([header, samples]));
}
