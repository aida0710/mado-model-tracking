import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  Code,
  CodeVersion,
  Dataset,
  DatasetVersion,
  ExperimentTask,
  PluginConnection,
  Run,
  TaskExecution,
  WorkerJob,
} from '@mmt/contracts';
import { workbenchFixture } from './workbenchFixtures.js';
import { createHarness, entity, request, testDatabaseUrl, type Harness } from './harness.js';
import { executionFixture, projectFixture } from './fixtures.js';

describe.skipIf(!testDatabaseUrl)('タスク・固定実行snapshot（独立PostgreSQL）', () => {
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

  it('タスクを一覧・取得し、通常/テスト起動のrevision・コマンド・変更差分を固定する', async () => {
    const fixture = await workbenchFixture(harness);
    expect(fixture.task).toMatchObject({
      revision: 1,
      description: '',
      inputDatasetVersionIds: [],
    });
    const listed = await entity<{ items: ExperimentTask[] }>(
      await request(
        harness.app,
        `${fixture.basePath}/tasks?experimentId=${fixture.experiment.id}`,
        { cookie: fixture.viewer.cookie },
      ),
      200,
    );
    expect(listed.items.map((task) => task.id)).toEqual([fixture.task.id]);
    expect(
      await entity(
        await request(harness.app, fixture.taskPath, { cookie: fixture.viewer.cookie }),
        200,
      ),
    ).toEqual(fixture.task);
    for (const mode of ['run', 'test'] as const) {
      const launch = await entity<TaskExecution>(
        await request(harness.app, `${fixture.taskPath}/launch`, {
          method: 'POST',
          cookie: fixture.editor.cookie,
          body: { expectedRevision: 1, executionMode: mode, parameters: { epochs: 3 }, gpuIds: [] },
        }),
      );
      expect(launch.run).toMatchObject({
        taskId: fixture.task.id,
        taskRevision: 1,
        executionMode: mode,
        codeVersionId: fixture.codeVersion.id,
        parameters: { epochs: 3, seed: 42 },
        tags: { task: 'fixture' },
      });
      expect(launch.run.executionSnapshot).toEqual({
        codeVersionId: fixture.codeVersion.id,
        version: fixture.codeVersion.version,
        mode,
        source: fixture.codeVersion.source,
        runtime: fixture.codeVersion.runtime,
        entrypoint:
          mode === 'test' ? fixture.codeVersion.testEntrypoint : fixture.codeVersion.entrypoint,
        requirements: fixture.codeVersion.requirements,
        environment: fixture.codeVersion.environment,
      });
      expect(launch.job.runId).toBe(launch.run.id);
      expect(launch.job.gpuIds).toEqual([]);
    }
    const history = await entity<{ items: Run[] }>(
      await request(harness.app, `${fixture.taskPath}/runs`, { cookie: fixture.viewer.cookie }),
      200,
    );
    expect(history.items).toHaveLength(2);
    expect(history.items.every((run) => run.taskRevision === 1)).toBe(true);
  });

  it('同じrevisionからの同時保存は一件だけ成功し、古いrevisionのlaunchは409になる', async () => {
    const fixture = await workbenchFixture(harness);
    const saves = await Promise.all(
      ['First', 'Second'].map((name) =>
        request(harness.app, fixture.taskPath, {
          method: 'PATCH',
          cookie: fixture.editor.cookie,
          body: { expectedRevision: 1, name },
        }),
      ),
    );
    expect(saves.map((response) => response.status).sort()).toEqual([200, 409]);
    const saved = await entity<ExperimentTask>(
      saves.find((response) => response.status === 200)!,
      200,
    );
    expect(saved.revision).toBe(2);
    const stale = await request(harness.app, `${fixture.taskPath}/launch`, {
      method: 'POST',
      cookie: fixture.editor.cookie,
      body: { expectedRevision: 1 },
    });
    expect(stale.status).toBe(409);
    expect((await stale.json()).code).toBe('task_revision_conflict');
    expect((await harness.database.query('SELECT id FROM runs')).rows).toHaveLength(0);
    expect(
      (
        await request(harness.app, fixture.taskPath, {
          method: 'PATCH',
          cookie: fixture.editor.cookie,
          body: { expectedRevision: 2, experimentId: randomUUID() },
        })
      ).status,
    ).toBe(422);
  });

  it('タスクを編集しても既存Runと再実行は以前のmode・コード・revisionを引き継ぐ', async () => {
    const fixture = await workbenchFixture(harness);
    const launch = await entity<TaskExecution>(
      await request(harness.app, `${fixture.taskPath}/launch`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: { expectedRevision: 1, executionMode: 'test' },
      }),
    );
    const claim = (
      await entity<{ item: WorkerJob }>(
        await request(harness.app, '/api/worker/claim', {
          method: 'POST',
          token: fixture.workerToken,
          body: { workerId: 'task-worker' },
        }),
        200,
      )
    ).item;
    expect(claim.run.executionSnapshot).toEqual(launch.run.executionSnapshot);
    expect(claim.run.executionSnapshot?.entrypoint).toEqual(['python', 'test.py']);
    await entity(
      await request(harness.app, `/api/worker/jobs/${claim.job.id}/complete`, {
        method: 'POST',
        token: fixture.workerToken,
        body: { leaseId: claim.job.leaseId, status: 'failed', exitCode: 1 },
      }),
      200,
    );
    const edited = await entity<ExperimentTask>(
      await request(harness.app, fixture.taskPath, {
        method: 'PATCH',
        cookie: fixture.editor.cookie,
        body: {
          expectedRevision: 1,
          codeVersionId: fixture.savedCode.id,
          parameters: { epochs: 10 },
          gpuIds: ['1'],
        },
      }),
      200,
    );
    expect(edited.revision).toBe(2);
    const retries = await Promise.all(
      Array.from({ length: 2 }, () =>
        request(harness.app, `${fixture.basePath}/jobs/${launch.job.id}/retry`, {
          method: 'POST',
          cookie: fixture.editor.cookie,
        }).then((response) => entity<TaskExecution>(response)),
      ),
    );
    expect(retries[0]!.run).toMatchObject({
      taskId: fixture.task.id,
      taskRevision: 1,
      executionMode: 'test',
      codeVersionId: fixture.codeVersion.id,
      parameters: fixture.task.parameters,
      parentRunId: launch.run.id,
    });
    expect(retries[0]!.run.executionSnapshot).toEqual(launch.run.executionSnapshot);
    expect(retries[1]!.run.id).toBe(retries[0]!.run.id);
    expect(retries[0]!.job.gpuIds).toEqual(['0']);
  });

  it('起動のGPU/参照/テストコマンドの検証失敗とJob保存失敗でRunもrollbackする', async () => {
    const fixture = await workbenchFixture(harness);
    for (const [override, status] of [
      [{ gpuIds: ['unknown'] }, 422],
      [{ modelVersionId: randomUUID() }, 404],
      [{ inputDatasetVersionIds: [randomUUID()] }, 404],
    ] as const) {
      expect(
        (
          await request(harness.app, `${fixture.taskPath}/launch`, {
            method: 'POST',
            cookie: fixture.editor.cookie,
            body: { expectedRevision: 1, ...override },
          })
        ).status,
      ).toBe(status);
    }
    await entity(
      await request(harness.app, fixture.taskPath, {
        method: 'PATCH',
        cookie: fixture.editor.cookie,
        body: { expectedRevision: 1, codeVersionId: fixture.savedCode.id },
      }),
      200,
    );
    const test = await request(harness.app, `${fixture.taskPath}/launch`, {
      method: 'POST',
      cookie: fixture.editor.cookie,
      body: { expectedRevision: 2, executionMode: 'test' },
    });
    expect(test.status).toBe(422);
    expect((await test.json()).code).toBe('test_entrypoint_required');
    await harness.database.query(
      "CREATE FUNCTION fail_task_job() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture failure'; END; $$",
    );
    await harness.database.query(
      'CREATE TRIGGER fail_task_job BEFORE INSERT ON jobs FOR EACH ROW EXECUTE FUNCTION fail_task_job()',
    );
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(
        (
          await request(harness.app, `${fixture.taskPath}/launch`, {
            method: 'POST',
            cookie: fixture.editor.cookie,
            body: { expectedRevision: 2 },
          })
        ).status,
      ).toBe(503);
      expect((await harness.database.query('SELECT id FROM runs')).rows).toHaveLength(0);
      expect((await harness.database.query('SELECT id FROM jobs')).rows).toHaveLength(0);
    } finally {
      log.mockRestore();
      await harness.database.query('DROP TRIGGER fail_task_job ON jobs');
      await harness.database.query('DROP FUNCTION fail_task_job()');
    }
  });

  it('viewer/outsiderと各token scopeを検証し、Run起動にはruns:writeとjobs:writeの両方が必要', async () => {
    const fixture = await workbenchFixture(harness);
    for (const cookie of [fixture.viewer.cookie, fixture.outsider.cookie]) {
      expect(
        (
          await request(harness.app, `${fixture.taskPath}/launch`, {
            method: 'POST',
            cookie,
            body: { expectedRevision: 1 },
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await request(harness.app, `${fixture.basePath}/tasks`, {
            method: 'POST',
            cookie,
            body: fixture.taskInput,
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await request(harness.app, fixture.taskPath, {
            method: 'PATCH',
            cookie,
            body: { expectedRevision: 1, name: 'Forbidden' },
          })
        ).status,
      ).toBe(403);
    }
    expect(
      (await request(harness.app, `${fixture.taskPath}/runs`, { cookie: fixture.outsider.cookie }))
        .status,
    ).toBe(403);
    for (const scopes of [['runs:write'], ['jobs:write'], ['registry:write'], ['read']]) {
      const token = await entity<{ token: string }>(
        await request(harness.app, '/api/tokens', {
          method: 'POST',
          cookie: fixture.administrator.cookie,
          body: { name: scopes[0], kind: 'service', projectId: fixture.project.id, scopes },
        }),
      );
      expect(
        (
          await request(harness.app, `${fixture.taskPath}/launch`, {
            method: 'POST',
            token: token.token,
            body: { expectedRevision: 1 },
          })
        ).status,
      ).toBe(403);
      expect(
        (await request(harness.app, `${fixture.basePath}/tasks`, { token: token.token })).status,
      ).toBe(scopes[0] === 'read' ? 200 : 403);
      expect(
        (
          await request(harness.app, `${fixture.basePath}/tasks`, {
            method: 'POST',
            token: token.token,
            body: fixture.taskInput,
          })
        ).status,
      ).toBe(scopes[0] === 'registry:write' ? 201 : 403);
    }
    const allowed = await entity<{ token: string }>(
      await request(harness.app, '/api/tokens', {
        method: 'POST',
        cookie: fixture.administrator.cookie,
        body: {
          name: 'Launcher',
          kind: 'service',
          projectId: fixture.project.id,
          scopes: ['runs:write', 'jobs:write'],
        },
      }),
    );
    expect(
      (
        await request(harness.app, `${fixture.taskPath}/launch`, {
          method: 'POST',
          token: allowed.token,
          body: { expectedRevision: 1 },
        })
      ).status,
    ).toBe(201);
  });

  it('他ProjectのCodeVersion/入力Dataset/Taskを読み書きできない', async () => {
    const fixture = await workbenchFixture(harness);
    const other = await projectFixture(harness);
    const code = await entity<Code>(
      await request(harness.app, `${other.basePath}/codes`, {
        method: 'POST',
        cookie: other.editor.cookie,
        body: { name: 'Other code' },
      }),
    );
    const codeVersion = await entity<CodeVersion>(
      await request(harness.app, `${other.basePath}/codes/${code.id}/versions`, {
        method: 'POST',
        cookie: other.editor.cookie,
        body: {
          version: 'v1',
          source: { kind: 'inline', files: { 'main.py': 'pass' } },
          entrypoint: ['python', 'main.py'],
          supportedModelFamilies: ['qwen2'],
          taskTypes: ['training'],
        },
      }),
    );
    const dataset = await entity<Dataset>(
      await request(harness.app, `${other.basePath}/datasets`, {
        method: 'POST',
        cookie: other.editor.cookie,
        body: { name: 'Other input' },
      }),
    );
    const datasetVersion = await entity<DatasetVersion>(
      await request(harness.app, `${other.basePath}/datasets/${dataset.id}/versions`, {
        method: 'POST',
        cookie: other.editor.cookie,
        body: { version: 'v1', uri: 's3://fixture/input', digest: 'fixed' },
      }),
    );
    for (const changes of [
      { codeVersionId: codeVersion.id },
      { inputDatasetVersionIds: [datasetVersion.id] },
    ])
      expect(
        (
          await request(harness.app, fixture.taskPath, {
            method: 'PATCH',
            cookie: fixture.editor.cookie,
            body: { expectedRevision: 1, ...changes },
          })
        ).status,
      ).toBe(404);
    expect(
      (
        await request(harness.app, `${other.basePath}/tasks/${fixture.task.id}`, {
          cookie: other.editor.cookie,
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await request(harness.app, `${other.basePath}/tasks/${fixture.task.id}/launch`, {
          method: 'POST',
          cookie: other.editor.cookie,
          body: { expectedRevision: 1 },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await request(harness.app, `${fixture.basePath}/tasks`, {
          method: 'POST',
          cookie: fixture.editor.cookie,
          body: { ...fixture.taskInput, experimentId: other.experiment.id },
        })
      ).status,
    ).toBe(404);
  });

  it('通常Runにもsnapshot/既定modeを保存し、HTTPとDBから固定実行内容を変更できない', async () => {
    const fixture = await executionFixture(harness);
    expect(fixture.codeVersion.testEntrypoint).toEqual([]);
    const run = await fixture.newRun();
    expect(run).toMatchObject({
      executionMode: 'run',
      taskId: null,
      taskRevision: null,
      executionSnapshot: { codeVersionId: fixture.codeVersion.id },
    });
    for (const changes of [
      { executionMode: 'test' },
      { executionSnapshot: { entrypoint: ['changed'] } },
      { taskRevision: 10 },
    ])
      expect(
        (
          await request(harness.app, `${fixture.basePath}/runs/${run.id}`, {
            method: 'PATCH',
            cookie: fixture.editor.cookie,
            body: changes,
          })
        ).status,
      ).toBe(422);
    await expect(
      harness.database.query(
        "UPDATE runs SET execution_snapshot=jsonb_set(execution_snapshot,'{version}','\"changed\"') WHERE id=$1",
        [run.id],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      harness.database.query("UPDATE runs SET execution_mode='test' WHERE id=$1", [run.id]),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      harness.database.query("UPDATE code_versions SET test_entrypoint='{changed}' WHERE id=$1", [
        fixture.codeVersion.id,
      ]),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('JobへのMLflow paramsは実行parametersを変えず、pluginイベントにはsource全文とENVを送らない', async () => {
    const fixture = await workbenchFixture(harness);
    await entity<PluginConnection>(
      await request(harness.app, `${fixture.basePath}/plugins`, {
        method: 'POST',
        cookie: fixture.administrator.cookie,
        body: { name: 'Lineage', baseUrl: 'http://127.0.0.1:4999', tokenEnv: 'FIXTURE_TOKEN' },
      }),
    );
    const launch = await entity<TaskExecution>(
      await request(harness.app, `${fixture.taskPath}/launch`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: { expectedRevision: 1 },
      }),
    );
    expect(
      (
        await request(
          harness.app,
          `/api/mlflow/projects/${fixture.project.id}/api/2.0/mlflow/runs/log-batch`,
          {
            method: 'POST',
            cookie: fixture.editor.cookie,
            body: {
              run_id: launch.run.id,
              params: [{ key: 'recorded', value: 'sdk-value' }],
              metrics: [],
              tags: [],
            },
          },
        )
      ).status,
    ).toBe(200);
    const run = await entity<Run>(
      await request(harness.app, `${fixture.basePath}/runs/${launch.run.id}`, {
        cookie: fixture.viewer.cookie,
      }),
      200,
    );
    expect(run.parameters).toEqual(fixture.task.parameters);
    expect(run.recordedParameters).toEqual({ recorded: 'sdk-value' });
    await entity(
      await request(harness.app, '/api/worker/claim', {
        method: 'POST',
        token: fixture.workerToken,
        body: { workerId: 'safe-event-worker' },
      }),
      200,
    );
    const events = (await harness.database.query('SELECT event FROM plugin_outbox')).rows;
    expect(events).toHaveLength(1);
    expect(events[0]!.event.run).toMatchObject({
      codeVersionId: fixture.codeVersion.id,
      taskId: fixture.task.id,
      taskRevision: 1,
      executionMode: 'run',
    });
    expect(events[0]!.event.run).not.toHaveProperty('executionSnapshot');
    expect(JSON.stringify(events)).not.toContain('fixture-only-setting');
    expect(JSON.stringify(events)).not.toContain('overlay');
  });
});
