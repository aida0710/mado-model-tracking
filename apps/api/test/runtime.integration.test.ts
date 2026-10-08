import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CodeVersion, ComputeTarget, Job, Project, Run, WorkerJob } from '@mmt/contracts';
import { createHarness, entity, request, testDatabaseUrl, type Harness } from './harness.js';
import { executionFixture } from './fixtures.js';
import {
  containerCodeInput,
  containerFixture,
  TEST_DOCKER_IMAGE,
  uploadFixtureArtifact,
} from './containerFixtures.js';

describe.skipIf(!testDatabaseUrl)('固定runtimeとtarget互換性（独立PostgreSQL）', () => {
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

  it('従来の登録入力はPythonへ正規化され、targetにもPythonが保存される', async () => {
    const fixture = await executionFixture(harness);
    expect(fixture.codeVersion.runtime).toEqual({ kind: 'python' });
    expect(fixture.target.runtimeKinds).toEqual(['python']);
    const run = await fixture.newRun();
    expect(run.environment.runtime).toEqual({ kind: 'python' });
  });

  it('Dockerはsourceなしでも登録でき、digestは外部registryへ接続せず保存する', async () => {
    const fixture = await executionFixture(harness);
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('External fetching is forbidden'));
    try {
      const version = await entity<CodeVersion>(
        await request(harness.app, `${fixture.basePath}/codes/${fixture.code.id}/versions`, {
          method: 'POST',
          cookie: fixture.editor.cookie,
          body: containerCodeInput({
            source: undefined,
            runtime: {
              kind: 'docker',
              image: TEST_DOCKER_IMAGE,
              workingDirectory: '/app',
            },
          }),
        }),
      );
      expect(version.source).toBeNull();
      expect(version.runtime).toEqual({
        kind: 'docker',
        image: TEST_DOCKER_IMAGE,
        workingDirectory: '/app',
      });
      expect(version.requirements).toEqual([]);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
    }
  });

  it.each([
    ['digestのないimage', { runtime: { kind: 'docker', image: 'repo/image:latest' } }],
    ['短いdigest', { runtime: { kind: 'docker', image: 'repo/image@sha256:abcd' } }],
    ['HTTP URL', { runtime: { kind: 'docker', image: `https://${TEST_DOCKER_IMAGE}` } }],
    [
      'credentialsを含むreference',
      {
        runtime: {
          kind: 'docker',
          image: `user:password@${TEST_DOCKER_IMAGE}`,
        },
      },
    ],
    ['空のrepository', { runtime: { kind: 'docker', image: `@sha256:${'a'.repeat(64)}` } }],
    ['未対応runtime', { runtime: { kind: 'podman', image: TEST_DOCKER_IMAGE } }],
    ['Pythonのsource省略', { source: undefined, runtime: { kind: 'python' } }],
    ['Pythonのsource null', { runtime: { kind: 'python' } }],
    [
      'Pythonの余計なruntime設定',
      {
        source: { kind: 'inline', files: { 'main.py': 'pass' } },
        runtime: { kind: 'python', image: TEST_DOCKER_IMAGE },
      },
    ],
    ['containerのrequirements', { requirements: ['torch'] }],
    [
      '相対cwd',
      {
        runtime: {
          kind: 'docker',
          image: TEST_DOCKER_IMAGE,
          workingDirectory: 'app',
        },
      },
    ],
    [
      'cwdのpath traversal',
      {
        runtime: {
          kind: 'docker',
          image: TEST_DOCKER_IMAGE,
          workingDirectory: '/app/../etc',
        },
      },
    ],
    [
      'NULを含むcwd',
      {
        runtime: {
          kind: 'docker',
          image: TEST_DOCKER_IMAGE,
          workingDirectory: '/app\0',
        },
      },
    ],
    ['空のentrypoint', { entrypoint: [] }],
    ['NULを含むargv', { entrypoint: ['python\0'] }],
    ['重複したfamilies', { supportedModelFamilies: ['qwen2', 'qwen2'] }],
    ['重複したtaskTypes', { taskTypes: ['inference', 'inference'] }],
  ])('%sを保存前に拒否する', async (_name, overrides) => {
    const fixture = await executionFixture(harness);
    const response = await request(
      harness.app,
      `${fixture.basePath}/codes/${fixture.code.id}/versions`,
      {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: containerCodeInput(overrides),
      },
    );
    expect(response.status).toBe(422);
    const versions = await harness.database.query('SELECT id FROM code_versions WHERE code_id=$1', [
      fixture.code.id,
    ]);
    expect(versions.rows).toHaveLength(1);
  });

  it.each(['singularity', 'apptainer'] as const)(
    '%sは同じProjectの保存済みSIFとSHA256を必要とする',
    async (kind) => {
      const fixture = await executionFixture(harness);
      const artifact = await uploadFixtureArtifact(harness, fixture, {
        path: 'runtime/image.sif',
      });
      const endpoint = `${fixture.basePath}/codes/${fixture.code.id}/versions`;
      const register = (runtime: object, version: string) =>
        request(harness.app, endpoint, {
          method: 'POST',
          cookie: fixture.editor.cookie,
          body: containerCodeInput({ version, runtime }),
        });
      const version = await entity<CodeVersion>(
        await register(
          {
            kind,
            artifactId: artifact.id,
            sha256: artifact.sha256,
            workingDirectory: '/app',
          },
          'sif-good',
        ),
      );
      expect(version.source).toBeNull();
      expect(version.runtime).toEqual({
        kind,
        artifactId: artifact.id,
        sha256: artifact.sha256,
        workingDirectory: '/app',
      });
      expect(
        (await register({ kind, artifactId: artifact.id, sha256: '0'.repeat(64) }, 'sif-bad-hash'))
          .status,
      ).toBe(422);
      expect(
        (await register({ kind, artifactId: randomUUID(), sha256: artifact.sha256 }, 'sif-missing'))
          .status,
      ).toBe(404);
      const other = await entity<Project>(
        await request(harness.app, '/api/projects', {
          method: 'POST',
          cookie: fixture.administrator.cookie,
          body: { name: 'Other artifacts' },
        }),
      );
      const foreign = await uploadFixtureArtifact(
        harness,
        {
          basePath: `/api/projects/${other.id}`,
          editor: fixture.administrator,
        },
        { path: 'foreign.sif' },
      );
      expect(
        (
          await register(
            { kind, artifactId: foreign.id, sha256: foreign.sha256 },
            'sif-other-project',
          )
        ).status,
      ).toBe(404);
    },
  );

  it('containerにもinline/artifact sourceを追加でき、artifactのProject境界を守る', async () => {
    const fixture = await executionFixture(harness);
    const artifact = await uploadFixtureArtifact(harness, fixture, {
      path: 'source.zip',
    });
    for (const source of [
      { kind: 'inline', files: { 'main.py': 'pass' } },
      { kind: 'artifact', artifactId: artifact.id },
    ]) {
      const version = await entity<CodeVersion>(
        await request(harness.app, `${fixture.basePath}/codes/${fixture.code.id}/versions`, {
          method: 'POST',
          cookie: fixture.editor.cookie,
          body: containerCodeInput({ version: source.kind, source }),
        }),
      );
      expect(version.source).toEqual(source);
    }
    expect(
      (
        await request(harness.app, `${fixture.basePath}/codes/${fixture.code.id}/versions`, {
          method: 'POST',
          cookie: fixture.editor.cookie,
          body: containerCodeInput({
            source: { kind: 'artifact', artifactId: randomUUID() },
          }),
        })
      ).status,
    ).toBe(404);
  });

  it('Runはruntimeを固定し、environmentのPATCHとDB UPDATEによる変更を拒否する', async () => {
    const fixture = await containerFixture(harness);
    const run = await entity<Run>(
      await request(harness.app, `${fixture.basePath}/runs`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: {
          experimentId: fixture.experiment.id,
          name: 'Container run',
          kind: 'inference',
          codeVersionId: fixture.containerCodeVersion.id,
        },
      }),
    );
    expect(run.environment.runtime).toEqual(fixture.containerCodeVersion.runtime);
    const endpoint = `${fixture.basePath}/runs/${run.id}`;
    expect(
      (
        await request(harness.app, endpoint, {
          method: 'PATCH',
          cookie: fixture.editor.cookie,
          body: { environment: { runtime: { kind: 'python' } } },
        })
      ).status,
    ).toBe(422);
    const patched = await entity<Run>(
      await request(harness.app, endpoint, {
        method: 'PATCH',
        cookie: fixture.editor.cookie,
        body: { environment: { host: 'fixture' } },
      }),
      200,
    );
    expect(patched.environment.runtime).toEqual(fixture.containerCodeVersion.runtime);
    expect(patched.environment.host).toBe('fixture');
    await expect(
      harness.database.query('UPDATE runs SET environment=$2 WHERE id=$1', [run.id, '{}']),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      harness.database.query('UPDATE code_versions SET runtime=$2 WHERE id=$1', [
        fixture.containerCodeVersion.id,
        '{"kind":"python"}',
      ]),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('未対応runtimeのJobを拒否し、登録後にtargetの対応runtimeが変わるとclaimしない', async () => {
    const fixture = await containerFixture(harness);
    const run = await entity<Run>(
      await request(harness.app, `${fixture.basePath}/runs`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: {
          experimentId: fixture.experiment.id,
          name: 'Pinned docker',
          kind: 'inference',
          codeVersionId: fixture.containerCodeVersion.id,
        },
      }),
    );
    const createJob = () =>
      request(harness.app, `${fixture.basePath}/jobs`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: { runId: run.id, targetId: fixture.target.id, gpuIds: ['0'] },
      });
    await harness.database.query('UPDATE compute_targets SET runtime_kinds=$2 WHERE id=$1', [
      fixture.target.id,
      ['python'],
    ]);
    expect((await createJob()).status).toBe(422);
    await harness.database.query('UPDATE compute_targets SET runtime_kinds=$2 WHERE id=$1', [
      fixture.target.id,
      ['docker'],
    ]);
    const job = await entity<Job>(await createJob());
    await harness.database.query('UPDATE compute_targets SET runtime_kinds=$2 WHERE id=$1', [
      fixture.target.id,
      ['python'],
    ]);
    const claim = await entity<{ item: WorkerJob | null }>(
      await request(harness.app, '/api/worker/claim', {
        method: 'POST',
        token: fixture.workerToken,
        body: { workerId: 'runtime-worker' },
      }),
      200,
    );
    expect(claim.item).toBeNull();
    expect(
      (await harness.database.query('SELECT status FROM jobs WHERE id=$1', [job.id])).rows[0]
        .status,
    ).toBe('queued');
    expect((await harness.database.query('SELECT * FROM gpu_reservations')).rows).toHaveLength(0);
    await harness.database.query('UPDATE compute_targets SET runtime_kinds=$2 WHERE id=$1', [
      fixture.target.id,
      ['docker'],
    ]);
    const supported = await entity<{ item: WorkerJob }>(
      await request(harness.app, '/api/worker/claim', {
        method: 'POST',
        token: fixture.workerToken,
        body: { workerId: 'runtime-worker' },
      }),
      200,
    );
    expect(supported.item.job.id).toBe(job.id);
    expect(supported.item.codeVersion.runtime).toEqual(run.environment.runtime);
  });

  it('worker claimもSIF hashを再検証し、不一致なら状態とGPU予約を残さない', async () => {
    const fixture = await containerFixture(harness);
    const artifact = await uploadFixtureArtifact(harness, fixture, {
      path: 'image.sif',
    });
    const version = await entity<CodeVersion>(
      await request(harness.app, `${fixture.basePath}/codes/${fixture.code.id}/versions`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: containerCodeInput({
          version: 'sif',
          runtime: {
            kind: 'apptainer',
            artifactId: artifact.id,
            sha256: artifact.sha256,
          },
        }),
      }),
    );
    const run = await entity<Run>(
      await request(harness.app, `${fixture.basePath}/runs`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: {
          experimentId: fixture.experiment.id,
          name: 'SIF',
          kind: 'inference',
          codeVersionId: version.id,
        },
      }),
    );
    const job = await entity<Job>(
      await request(harness.app, `${fixture.basePath}/jobs`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: { runId: run.id, targetId: fixture.target.id, gpuIds: ['0'] },
      }),
    );
    await harness.database.query('UPDATE artifacts SET sha256=$2 WHERE id=$1', [
      artifact.id,
      '0'.repeat(64),
    ]);
    expect(
      (
        await request(harness.app, '/api/worker/claim', {
          method: 'POST',
          token: fixture.workerToken,
          body: { workerId: 'sif-worker' },
        })
      ).status,
    ).toBe(422);
    expect(
      (await harness.database.query('SELECT status FROM jobs WHERE id=$1', [job.id])).rows[0]
        .status,
    ).toBe('queued');
    expect((await harness.database.query('SELECT * FROM gpu_reservations')).rows).toHaveLength(0);
    expect((await harness.database.query('SELECT * FROM plugin_outbox')).rows).toHaveLength(0);
  });

  it.each([[[]], [['docker', 'docker']], [['podman']]])(
    '無効なruntimeKinds %jのtargetを拒否する',
    async (runtimeKinds) => {
      const fixture = await executionFixture(harness);
      const { id: _id, ...target } = fixture.target;
      expect(
        (
          await request(harness.app, '/api/targets', {
            method: 'POST',
            cookie: fixture.administrator.cookie,
            body: { ...target, name: 'Invalid target', runtimeKinds },
          })
        ).status,
      ).toBe(422);
      const targets = await entity<{ items: ComputeTarget[] }>(
        await request(harness.app, '/api/targets', {
          cookie: fixture.viewer.cookie,
        }),
        200,
      );
      expect(targets.items[0]!.runtimeKinds).toEqual(['python']);
    },
  );
});
