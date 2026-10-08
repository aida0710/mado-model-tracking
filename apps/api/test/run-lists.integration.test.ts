import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type {
  CodeVersion,
  ExperimentTask,
  Run,
  TaskExecution,
  TaskRunPage,
  WorkerJob,
} from '@mmt/contracts';
import { createHarness, entity, request, testDatabaseUrl, type Harness } from './harness.js';
import { workbenchFixture } from './workbenchFixtures.js';

// Repeated snapshots must not grow polling responses by several MiB.
const SOURCE_PADDING_BYTES = 1024 * 1024;
const MAX_RUN_LIST_RESPONSE_BYTES = 64 * 1024;
const SOURCE_CONTENT_MARKER = 'snapshot-only-source';
const CODE_ENVIRONMENT_MARKER = 'snapshot-only-environment';

async function readRunList(
  harness: Harness,
  reference: { endpoint: string; cookie: string },
): Promise<{ body: string; items: Run[] }> {
  const response = await request(harness.app, reference.endpoint, { cookie: reference.cookie });
  expect(response.status).toBe(200);
  const body = await response.text();
  return { body, items: (JSON.parse(body) as { items: Run[] }).items };
}

describe.skipIf(!testDatabaseUrl)('Run一覧とタスク履歴の概要（独立PostgreSQL）', () => {
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

  it('大きなコードの一覧は固定参照の概要を返し、詳細とworker claimにはsnapshotを返す', async () => {
    const fixture = await workbenchFixture(harness);
    const sourceText = `# ${SOURCE_CONTENT_MARKER}${'x'.repeat(SOURCE_PADDING_BYTES)}\n`;
    const source = { kind: 'inline', files: { 'main.py': sourceText, 'helper.py': sourceText } };
    const codeVersion = await entity<CodeVersion>(
      await request(harness.app, `${fixture.basePath}/codes/${fixture.code.id}/versions`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: {
          version: 'large-source',
          source,
          entrypoint: ['python', 'main.py'],
          testEntrypoint: ['python', 'helper.py'],
          environment: { CODE_VERSION_ONLY_ENV: CODE_ENVIRONMENT_MARKER },
          supportedModelFamilies: ['qwen2'],
          taskTypes: ['training'],
        },
      }),
    );
    const task = await entity<ExperimentTask>(
      await request(harness.app, fixture.taskPath, {
        method: 'PATCH',
        cookie: fixture.editor.cookie,
        body: { expectedRevision: 1, codeVersionId: codeVersion.id },
      }),
      200,
    );
    const launches: TaskExecution[] = [];
    for (const executionMode of ['run', 'test'] as const) {
      launches.push(
        await entity<TaskExecution>(
          await request(harness.app, `${fixture.taskPath}/launch`, {
            method: 'POST',
            cookie: fixture.editor.cookie,
            body: { expectedRevision: task.revision, executionMode },
          }),
        ),
      );
    }
    const nativeRun = await entity<Run>(
      await request(harness.app, `${fixture.basePath}/runs`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: {
          experimentId: fixture.experiment.id,
          name: 'Native large-source run',
          kind: 'training',
          codeVersionId: codeVersion.id,
          modelVersionId: fixture.modelVersion.id,
          parameters: { seed: 7 },
          tags: { purpose: 'summary' },
        },
      }),
    );
    const taskRuns = launches.map((launch) => launch.run);
    for (const { endpoint, expectedRuns } of [
      { endpoint: `${fixture.taskPath}/runs`, expectedRuns: taskRuns },
      { endpoint: `${fixture.basePath}/runs`, expectedRuns: [...taskRuns, nativeRun] },
    ]) {
      const listed = await readRunList(harness, { endpoint, cookie: fixture.viewer.cookie });
      expect(Buffer.byteLength(listed.body)).toBeLessThan(MAX_RUN_LIST_RESPONSE_BYTES);
      expect(listed.body).not.toContain(SOURCE_CONTENT_MARKER);
      expect(listed.body).not.toContain(CODE_ENVIRONMENT_MARKER);
      expect(listed.items.map((run) => run.id).sort()).toEqual(
        expectedRuns.map((run) => run.id).sort(),
      );
      for (const expected of expectedRuns) {
        const summary = listed.items.find((run) => run.id === expected.id)!;
        expect(summary).not.toHaveProperty('executionSnapshot');
        expect(summary).toMatchObject({
          projectId: expected.projectId,
          experimentId: expected.experimentId,
          name: expected.name,
          kind: expected.kind,
          status: expected.status,
          codeVersionId: expected.codeVersionId,
          modelVersionId: expected.modelVersionId,
          taskId: expected.taskId,
          taskRevision: expected.taskRevision,
          executionMode: expected.executionMode,
          parameters: expected.parameters,
          recordedParameters: expected.recordedParameters,
          tags: expected.tags,
          latestMetrics: expected.latestMetrics,
          environment: expected.environment,
          createdAt: expected.createdAt,
          inputDatasetVersionIds: expected.inputDatasetVersionIds,
          outputDatasetVersionIds: expected.outputDatasetVersionIds,
        });
      }
    }
    const firstPage = await entity<TaskRunPage>(
      await request(harness.app, `${fixture.taskPath}/runs?limit=1`, {
        cookie: fixture.viewer.cookie,
      }),
      200,
    );
    expect(firstPage.items).toHaveLength(1);
    expect(firstPage.nextCursor).toBe(firstPage.items[0]!.id);
    const finalPage = await entity<TaskRunPage>(
      await request(
        harness.app,
        `${fixture.taskPath}/runs?limit=1&cursor=${firstPage.nextCursor}`,
        {
          cookie: fixture.viewer.cookie,
        },
      ),
      200,
    );
    expect(finalPage.items).toHaveLength(1);
    expect(finalPage.nextCursor).toBeNull();
    expect([...firstPage.items, ...finalPage.items].map((run) => run.id).sort()).toEqual(
      taskRuns.map((run) => run.id).sort(),
    );
    for (const page of [firstPage, finalPage]) {
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(MAX_RUN_LIST_RESPONSE_BYTES);
      expect(page.items[0]).not.toHaveProperty('executionSnapshot');
    }
    const detailedRun = await entity<Run>(
      await request(harness.app, `${fixture.basePath}/runs/${taskRuns[0]!.id}`, {
        cookie: fixture.viewer.cookie,
      }),
      200,
    );
    expect(detailedRun.executionSnapshot?.source).toEqual(source);
    expect(detailedRun.executionSnapshot?.environment).toEqual(codeVersion.environment);
    const claimed = (
      await entity<{ item: WorkerJob }>(
        await request(harness.app, '/api/worker/claim', {
          method: 'POST',
          token: fixture.workerToken,
          body: { workerId: 'summary-detail-worker' },
        }),
        200,
      )
    ).item;
    expect(claimed.run.id).toBe(taskRuns[0]!.id);
    expect(claimed.run.executionSnapshot).toEqual(detailedRun.executionSnapshot);
    expect(claimed.codeVersion.source).toEqual(source);
  });

  it('MLflowでRunを削除すると履歴と通常一覧から消え、restoreすると同じsnapshotで再表示する', async () => {
    const fixture = await workbenchFixture(harness);
    const launch = await entity<TaskExecution>(
      await request(harness.app, `${fixture.taskPath}/launch`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: { expectedRevision: 1, executionMode: 'test' },
      }),
    );
    await entity(
      await request(harness.app, `${fixture.basePath}/jobs/${launch.job.id}/cancel`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
      }),
      200,
    );
    const endpoints = [`${fixture.taskPath}/runs`, `${fixture.basePath}/runs`];
    for (const endpoint of endpoints) {
      const listed = await readRunList(harness, { endpoint, cookie: fixture.viewer.cookie });
      expect(listed.items.map((run) => run.id)).toEqual([launch.run.id]);
    }
    const mlflowPath = `/api/mlflow/projects/${fixture.project.id}/api/2.0/mlflow/runs`;
    await entity(
      await request(harness.app, `${mlflowPath}/delete`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: { run_id: launch.run.id },
      }),
      200,
    );
    for (const endpoint of endpoints) {
      const listed = await readRunList(harness, { endpoint, cookie: fixture.viewer.cookie });
      expect(listed.items.map((run) => run.id)).toEqual([]);
    }
    await entity(
      await request(harness.app, `${mlflowPath}/restore`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: { run_id: launch.run.id },
      }),
      200,
    );
    for (const endpoint of endpoints) {
      const listed = await readRunList(harness, { endpoint, cookie: fixture.viewer.cookie });
      expect(listed.items.map((run) => run.id)).toEqual([launch.run.id]);
      expect(listed.items[0]).toMatchObject({
        status: 'canceled',
        taskId: fixture.task.id,
        taskRevision: 1,
        executionMode: 'test',
      });
      expect(listed.items[0]).not.toHaveProperty('executionSnapshot');
    }
    const restored = await entity<Run>(
      await request(harness.app, `${fixture.basePath}/runs/${launch.run.id}`, {
        cookie: fixture.viewer.cookie,
      }),
      200,
    );
    expect(restored.executionSnapshot).toEqual(launch.run.executionSnapshot);
  });
});
