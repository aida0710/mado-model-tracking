import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ExperimentTask, Run, TaskRunPage } from '@mmt/contracts';
import { createHarness, entity, request, testDatabaseUrl, type Harness } from './harness.js';
import { workbenchFixture } from './workbenchFixtures.js';
import { projectFixture } from './fixtures.js';

// The page contract is default 50/max 200; exceed it to detect an unbounded query.
const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 200;
const HISTORY_RUN_COUNT = MAX_PAGE_LIMIT + 1;
// Uneven pages exercise both continuation and the final short page.
const TEST_PAGE_LIMIT = 17;
const SHARED_CREATED_AT = '2026-10-08 00:00:00.123456+00';
type TaskFixture = Awaited<ReturnType<typeof workbenchFixture>>;

async function insertHistoryRuns(
  harness: Harness,
  registration: { fixture: TaskFixture; count: number; taskId?: string },
): Promise<string[]> {
  const { fixture } = registration;
  const inserted = await harness.database.query<{ id: string }>(
    `INSERT INTO runs(project_id,experiment_id,name,kind,code_version_id,model_version_id,
      created_by,task_id,task_revision,execution_mode,created_at)
      SELECT $1,$2,'History '||sequence,'training',$3,$4,$5,$6,1,'run',$7::timestamptz
      FROM generate_series(1,$8::integer) AS sequence RETURNING id`,
    [
      fixture.project.id,
      fixture.experiment.id,
      fixture.codeVersion.id,
      fixture.modelVersion.id,
      fixture.editor.userId,
      registration.taskId ?? fixture.task.id,
      SHARED_CREATED_AT,
      registration.count,
    ],
  );
  return inserted.rows
    .map((run) => run.id)
    .sort()
    .reverse();
}

async function historyPage(
  harness: Harness,
  reference: { fixture: TaskFixture; limit?: number; cursor?: string },
): Promise<TaskRunPage> {
  const query = new URLSearchParams();
  if (reference.limit !== undefined) query.set('limit', String(reference.limit));
  if (reference.cursor !== undefined) query.set('cursor', reference.cursor);
  return entity<TaskRunPage>(
    await request(harness.app, `${reference.fixture.taskPath}/runs?${query}`, {
      cookie: reference.fixture.viewer.cookie,
    }),
    200,
  );
}

describe.skipIf(!testDatabaseUrl)('Task履歴の上限付きcursor（独立PostgreSQL）', () => {
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

  it('既定50件・最大200件を返し、不正limitを422で拒否する', async () => {
    const fixture = await workbenchFixture(harness);
    const runIds = await insertHistoryRuns(harness, { fixture, count: HISTORY_RUN_COUNT });
    const defaultPage = await historyPage(harness, { fixture });
    expect(defaultPage.items.map((run) => run.id)).toEqual(runIds.slice(0, DEFAULT_PAGE_LIMIT));
    expect(defaultPage.nextCursor).toBe(defaultPage.items.at(-1)!.id);
    const maximumPage = await historyPage(harness, { fixture, limit: MAX_PAGE_LIMIT });
    expect(maximumPage.items.map((run) => run.id)).toEqual(runIds.slice(0, MAX_PAGE_LIMIT));
    expect(maximumPage.nextCursor).toBe(maximumPage.items.at(-1)!.id);
    for (const limit of ['0', '-1', '201', '1.5', 'not-a-number']) {
      expect(
        (
          await request(harness.app, `${fixture.taskPath}/runs?limit=${limit}`, {
            cookie: fixture.viewer.cookie,
          })
        ).status,
      ).toBe(422);
    }
  });

  it('同時刻のRunをid順にpage送りして重複・漏れなく全件取得する', async () => {
    const fixture = await workbenchFixture(harness);
    const runIds = await insertHistoryRuns(harness, { fixture, count: HISTORY_RUN_COUNT });
    const receivedIds: string[] = [];
    let cursor: string | null = null;
    const pageCount = Math.ceil(HISTORY_RUN_COUNT / TEST_PAGE_LIMIT);
    for (let pageIndex = 0; pageIndex < pageCount; pageIndex++) {
      const page = await historyPage(harness, {
        fixture,
        limit: TEST_PAGE_LIMIT,
        ...(cursor ? { cursor } : {}),
      });
      expect(page.items.length).toBeLessThanOrEqual(TEST_PAGE_LIMIT);
      expect(page.items.every((run) => !Object.hasOwn(run, 'executionSnapshot'))).toBe(true);
      receivedIds.push(...page.items.map((run) => run.id));
      cursor = page.nextCursor;
      if (pageIndex < pageCount - 1) expect(cursor).toBe(page.items.at(-1)!.id);
    }
    expect(cursor).toBeNull();
    expect(receivedIds).toEqual(runIds);
    expect(new Set(receivedIds).size).toBe(HISTORY_RUN_COUNT);
  });

  it('cursorのmicrosecondsを失わず同じmillisecond内のRunも全件取得する', async () => {
    const fixture = await workbenchFixture(harness);
    const runIds = await insertHistoryRuns(harness, { fixture, count: 3 });
    for (const [index, id] of runIds.entries()) {
      await harness.database.query('UPDATE runs SET created_at=$2::timestamptz WHERE id=$1', [
        id,
        `2026-10-08 00:00:00.12300${index}+00`,
      ]);
    }
    const receivedIds: string[] = [];
    let cursor: string | undefined;
    for (let pageIndex = 0; pageIndex < runIds.length; pageIndex++) {
      const page = await historyPage(harness, { fixture, limit: 1, cursor });
      expect(page.items).toHaveLength(1);
      receivedIds.push(page.items[0]!.id);
      cursor = page.nextCursor ?? undefined;
    }
    expect(cursor).toBeUndefined();
    expect(receivedIds).toEqual([...runIds].reverse());
  });

  it('削除済みcursorを境界に使い、空の最終pageではnextCursorをnullにする', async () => {
    const fixture = await workbenchFixture(harness);
    const runIds = await insertHistoryRuns(harness, { fixture, count: 3 });
    const first = await historyPage(harness, { fixture, limit: 1 });
    expect(first.nextCursor).toBe(runIds[0]);
    await entity(
      await request(
        harness.app,
        `/api/mlflow/projects/${fixture.project.id}/api/2.0/mlflow/runs/delete`,
        {
          method: 'POST',
          cookie: fixture.editor.cookie,
          body: { run_id: first.nextCursor },
        },
      ),
      200,
    );
    const second = await historyPage(harness, { fixture, limit: 1, cursor: first.nextCursor! });
    expect(second.items.map((run) => run.id)).toEqual([runIds[1]]);
    expect(second.nextCursor).toBe(runIds[1]);
    const final = await historyPage(harness, { fixture, cursor: second.nextCursor! });
    expect(final.items.map((run) => run.id)).toEqual([runIds[2]]);
    expect(final.nextCursor).toBeNull();
    expect(await historyPage(harness, { fixture, cursor: runIds[2] })).toEqual({
      items: [],
      nextCursor: null,
    });
  });

  it('他task/project・存在しないcursorは404、不正UUIDは422になり履歴を開示しない', async () => {
    const fixture = await workbenchFixture(harness);
    const otherTask = await entity<ExperimentTask>(
      await request(harness.app, `${fixture.basePath}/tasks`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: { ...fixture.taskInput, name: 'Other task' },
      }),
    );
    const otherTaskIds = await insertHistoryRuns(harness, {
      fixture,
      taskId: otherTask.id,
      count: 1,
    });
    const otherProject = await projectFixture(harness);
    const otherRun = await entity<Run>(
      await request(harness.app, `${otherProject.basePath}/runs`, {
        method: 'POST',
        cookie: otherProject.editor.cookie,
        body: {
          experimentId: otherProject.experiment.id,
          name: 'Other project run',
          kind: 'processing',
        },
      }),
    );
    for (const cursor of [otherTaskIds[0]!, otherRun.id, randomUUID()]) {
      const rejected = await request(harness.app, `${fixture.taskPath}/runs?cursor=${cursor}`, {
        cookie: fixture.viewer.cookie,
      });
      expect(rejected.status).toBe(404);
      expect(await rejected.json()).toMatchObject({ code: 'not_found' });
    }
    expect(
      (
        await request(harness.app, `${fixture.taskPath}/runs?cursor=not-a-uuid`, {
          cookie: fixture.viewer.cookie,
        })
      ).status,
    ).toBe(422);
  });
});
