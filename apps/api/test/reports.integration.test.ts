import type {
  Comment,
  Experiment,
  Project,
  Report,
  ReportBlock,
  ReportDetail,
  ReportPage,
  ReportRevisionSummary,
  Run,
  SavedView,
  Sweep,
} from '@mmt/contracts';
import {
  reportDetailSchema,
  reportPageSchema,
  reportRevisionListSchema,
  reportSchema,
} from '@mmt/contracts/schemas';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, entity, login, request, testDatabaseUrl, type Harness } from './harness.js';
import { sweepFixture } from './sweepFixtures.js';

type Identity = { cookie: string; userId: string };
type Fixture = Awaited<ReturnType<typeof sweepFixture>>;

const EMPTY_VIEW_STATE = {
  version: 1,
  experimentIds: [],
  filter: '',
  orderBy: [],
  statuses: [],
  kinds: [],
  columns: [],
  chartPanels: { version: 1, columns: 12, panels: [] },
};

describe.skipIf(!testDatabaseUrl)('共有レポートのバージョンと権限（独立PostgreSQL）', () => {
  let harness: Harness;
  let fixture: Fixture;
  let secondEditor: Identity;
  let run: Run;
  let reportsPath: string;

  beforeAll(async () => {
    harness = await createHarness();
  });
  beforeEach(async () => {
    await harness.reset();
    fixture = await sweepFixture(harness);
    secondEditor = await login(harness, 'editor2@localhost');
    await entity(
      await request(harness.app, `${fixture.basePath}/members/${secondEditor.userId}`, {
        method: 'PUT',
        cookie: fixture.administrator.cookie,
        body: { role: 'editor' },
      }),
      200,
    );
    run = await createRun(fixture.basePath, fixture.experiment.id);
    reportsPath = `${fixture.basePath}/reports`;
  });
  afterAll(async () => {
    await harness?.close();
  });

  async function createRun(basePath: string, experimentId: string): Promise<Run> {
    return entity<Run>(
      await request(harness.app, `${basePath}/runs`, {
        method: 'POST',
        cookie: fixture.administrator.cookie,
        body: { experimentId, name: 'train', kind: 'training' },
      }),
    );
  }

  async function otherProject() {
    const project = await entity<Project>(
      await request(harness.app, '/api/projects', {
        method: 'POST',
        cookie: fixture.administrator.cookie,
        body: { name: 'Other Project' },
      }),
    );
    const basePath = `/api/projects/${project.id}`;
    const experiment = await entity<Experiment>(
      await request(harness.app, `${basePath}/experiments`, {
        method: 'POST',
        cookie: fixture.administrator.cookie,
        body: { name: 'Other Experiment' },
      }),
    );
    return { project, basePath, experiment };
  }

  function markdown(text: string, id = 'intro'): ReportBlock {
    return { type: 'markdown', id, text };
  }

  function runTable(runSet: Record<string, unknown>, id = 'runs'): Record<string, unknown> {
    return { type: 'run_table', id, runSet, columns: ['metrics.loss'], limit: 10, mode: 'live' };
  }

  function postReport(
    body: { title?: string; blocks: unknown[] },
    identity: Identity = fixture.editor,
    path = reportsPath,
  ) {
    return request(harness.app, path, {
      method: 'POST',
      cookie: identity.cookie,
      body: { title: 'Weekly results', ...body },
    });
  }

  async function createReport(blocks: unknown[] = [markdown('# v1')]): Promise<ReportDetail> {
    return entity<ReportDetail>(await postReport({ blocks }));
  }

  function putReport(
    reportId: string,
    body: Record<string, unknown>,
    identity: Identity = fixture.editor,
  ) {
    return request(harness.app, `${reportsPath}/${reportId}`, {
      method: 'PUT',
      cookie: identity.cookie,
      body: { title: 'Weekly results', ...body },
    });
  }

  function reportAction(reportId: string, action: string, identity: Identity, body?: unknown) {
    return request(harness.app, `${reportsPath}/${reportId}/${action}`, {
      method: 'POST',
      cookie: identity.cookie,
      ...(body === undefined ? {} : { body }),
    });
  }

  async function errorCode(response: Response): Promise<string> {
    return ((await response.json()) as { code: string }).code;
  }

  async function createSavedView(
    visibility: 'private' | 'project',
    identity: Identity,
    basePath = fixture.basePath,
  ): Promise<SavedView> {
    return entity<SavedView>(
      await request(harness.app, `${basePath}/saved-views`, {
        method: 'POST',
        cookie: identity.cookie,
        body: { visibility, name: `${visibility}-${identity.userId}`, state: EMPTY_VIEW_STATE },
      }),
    );
  }

  it('編集ごとにバージョンが増え、古いbaseRevisionは409で上書きせず、restoreは新しいバージョンとして戻す', async () => {
    const created = await createReport([markdown('# v1'), runTable({ runIds: [run.id] })]);
    expect(created.report).toMatchObject({
      title: 'Weekly results',
      currentRevision: 1,
      createdBy: { id: fixture.editor.userId },
      updatedBy: { id: fixture.editor.userId },
      archivedAt: null,
    });
    expect(created.revision).toMatchObject({ revision: 1, restoredFromRevision: null });
    // Responses have exactly the published shape (docs/openapi.json).
    reportDetailSchema.parse(created);

    // Any Project editor may save; the revision records who did.
    const edited = await entity<ReportDetail>(
      await putReport(
        created.report.id,
        { baseRevision: 1, title: 'Weekly results v2', blocks: [markdown('# v2')], message: '結論を追記' },
        secondEditor,
      ),
      200,
    );
    expect(edited.report).toMatchObject({
      currentRevision: 2,
      title: 'Weekly results v2',
      createdBy: { id: fixture.editor.userId },
      updatedBy: { id: secondEditor.userId },
    });
    expect(edited.revision).toMatchObject({
      revision: 2,
      message: '結論を追記',
      createdBy: { id: secondEditor.userId },
    });

    const stale = await putReport(created.report.id, {
      baseRevision: 1,
      blocks: [markdown('# lost update')],
    });
    expect(stale.status).toBe(409);
    expect(await errorCode(stale)).toBe('report_revision_conflict');

    const restored = await entity<ReportDetail>(
      await reportAction(created.report.id, 'restore', fixture.editor, { revision: 1 }),
    );
    expect(restored.revision).toMatchObject({
      revision: 3,
      title: created.revision.title,
      blocks: created.revision.blocks,
      restoredFromRevision: 1,
    });
    expect(restored.report).toMatchObject({ currentRevision: 3, title: 'Weekly results' });

    const history = await entity<{ items: ReportRevisionSummary[] }>(
      await request(harness.app, `${reportsPath}/${created.report.id}/revisions`, {
        cookie: fixture.viewer.cookie,
      }),
      200,
    );
    reportRevisionListSchema.parse(history);
    expect(history.items.map((revision) => revision.revision)).toEqual([3, 2, 1]);
    const first = await entity<ReportDetail>(
      await request(harness.app, `${reportsPath}/${created.report.id}?revision=2`, {
        cookie: fixture.viewer.cookie,
      }),
      200,
    );
    expect(first.revision.blocks).toEqual([markdown('# v2')]);
    expect(
      (
        await request(harness.app, `${reportsPath}/${created.report.id}?revision=4`, {
          cookie: fixture.viewer.cookie,
        })
      ).status,
    ).toBe(404);
  });

  it('viewerは読めるが作成・編集は403、アーカイブは作成者かProject adminだけ', async () => {
    const created = await createReport();
    expect((await postReport({ blocks: [] }, fixture.viewer)).status).toBe(403);
    expect(
      (await putReport(created.report.id, { baseRevision: 1, blocks: [] }, fixture.viewer)).status,
    ).toBe(403);
    expect(
      (await request(harness.app, `${reportsPath}/${created.report.id}`, { cookie: fixture.viewer.cookie }))
        .status,
    ).toBe(200);
    expect(
      (await request(harness.app, `${reportsPath}/${created.report.id}`, { cookie: fixture.outsider.cookie }))
        .status,
    ).toBe(403);

    const byOtherEditor = await reportAction(created.report.id, 'archive', secondEditor);
    expect(byOtherEditor.status).toBe(403);
    expect(await errorCode(byOtherEditor)).toBe('report_owner_required');
    const archived = await entity<Report>(
      await reportAction(created.report.id, 'archive', fixture.editor),
      200,
    );
    reportSchema.parse(archived);
    expect(archived).toMatchObject({ archivedBy: { id: fixture.editor.userId } });
    expect(archived.archivedAt).not.toBeNull();

    const editArchived = await putReport(created.report.id, { baseRevision: 1, blocks: [] });
    expect(editArchived.status).toBe(409);
    expect(await errorCode(editArchived)).toBe('report_archived');
    const listed = async (query = '') =>
      (
        await entity<ReportPage>(
          await request(harness.app, `${reportsPath}${query}`, { cookie: fixture.viewer.cookie }),
          200,
        )
      ).items.map((report) => report.id);
    expect(await listed()).toEqual([]);
    expect(await listed('?includeArchived=true')).toEqual([created.report.id]);

    // The Project admin may unarchive a report someone else created.
    const unarchived = await entity<Report>(
      await reportAction(created.report.id, 'unarchive', fixture.administrator),
      200,
    );
    expect(unarchived).toMatchObject({ archivedAt: null, archivedBy: null });
    expect(await listed()).toEqual([created.report.id]);
  });

  it('一覧は更新の新しい順にcursorで辿れる', async () => {
    const reports: ReportDetail[] = [];
    for (let index = 0; index < 3; index += 1) reports.push(await createReport());
    // Saving a revision moves the report to the top.
    await entity(await putReport(reports[0]!.report.id, { baseRevision: 1, blocks: [] }), 200);
    const firstPage = await entity<ReportPage>(
      await request(harness.app, `${reportsPath}?limit=2`, { cookie: fixture.viewer.cookie }),
      200,
    );
    const secondPage = await entity<ReportPage>(
      await request(harness.app, `${reportsPath}?limit=2&cursor=${firstPage.nextCursor}`, {
        cookie: fixture.viewer.cookie,
      }),
      200,
    );
    expect([...firstPage.items, ...secondPage.items].map((report) => report.id)).toEqual([
      reports[0]!.report.id,
      reports[2]!.report.id,
      reports[1]!.report.id,
    ]);
    expect(secondPage.nextCursor).toBeNull();
    reportPageSchema.parse(firstPage);
    const foreignCursor = await request(
      harness.app,
      `${reportsPath}?cursor=00000000-0000-4000-8000-000000000000`,
      { cookie: fixture.viewer.cookie },
    );
    expect(foreignCursor.status).toBe(400);
    expect(await errorCode(foreignCursor)).toBe('invalid_cursor');
  });

  it('他ProjectのRun・Sweep・保存ビューを参照すると422', async () => {
    const other = await otherProject();
    const otherRun = await createRun(other.basePath, other.experiment.id);
    const sweep = await fixture.createSweep({
      name: 'grid',
      method: 'grid',
      searchSpace: { lr: { values: [0.1, 0.01] } },
      objective: { metric: 'loss', goal: 'minimize' },
      maxTrials: 2,
    });
    const otherView = await createSavedView('project', fixture.administrator, other.basePath);
    const rejected = [
      runTable({ runIds: [run.id, otherRun.id] }),
      runTable({ sweepId: '00000000-0000-4000-8000-000000000000' }),
      runTable({ savedViewId: otherView.id }),
      runTable({ search: { experimentIds: [other.experiment.id] } }),
      { type: 'media', id: 'media', runIds: [otherRun.id], key: 'audio', mode: 'live' },
    ];
    for (const block of rejected) {
      const response = await postReport({ blocks: [block] });
      expect(response.status, JSON.stringify(block)).toBe(422);
      expect(await errorCode(response)).toBe('report_reference_invalid');
    }
    // The sweep exists, but in this report's Project only.
    const otherProjectReport = await request(harness.app, `${other.basePath}/reports`, {
      method: 'POST',
      cookie: fixture.administrator.cookie,
      body: { title: 'x', blocks: [runTable({ sweepId: sweep.id })] },
    });
    expect(otherProjectReport.status).toBe(422);
    expect(await errorCode(otherProjectReport)).toBe('report_reference_invalid');
    expect((await postReport({ blocks: [runTable({ sweepId: sweep.id })] })).status).toBe(201);
  });

  it('非公開の保存ビューは自分のものでも参照できず、Project公開のビューは参照できる', async () => {
    for (const owner of [fixture.editor, secondEditor]) {
      const privateView = await createSavedView('private', owner);
      const response = await postReport({ blocks: [runTable({ savedViewId: privateView.id })] });
      expect(response.status).toBe(422);
      expect(await errorCode(response)).toBe('report_saved_view_private');
    }
    const sharedView = await createSavedView('project', secondEditor);
    expect((await postReport({ blocks: [runTable({ savedViewId: sharedView.id })] })).status).toBe(
      201,
    );
  });

  it('reportへコメントでき、アーカイブ後は読めるが投稿は409', async () => {
    const created = await createReport();
    const commentsPath = `${fixture.basePath}/comments`;
    const target = { targetType: 'report', targetId: created.report.id };
    const posted = await entity<Comment>(
      await request(harness.app, commentsPath, {
        method: 'POST',
        cookie: secondEditor.cookie,
        body: { ...target, body: '図の軸を確認したい' },
      }),
    );
    expect(posted).toMatchObject({ targetType: 'report', targetId: created.report.id });
    await entity(await reportAction(created.report.id, 'archive', fixture.editor), 200);
    const afterArchive = await request(harness.app, commentsPath, {
      method: 'POST',
      cookie: secondEditor.cookie,
      body: { ...target, body: 'もう一件' },
    });
    expect(afterArchive.status).toBe(409);
    expect(await errorCode(afterArchive)).toBe('comment_target_deleted');
    const thread = await entity<{ items: Comment[] }>(
      await request(
        harness.app,
        `${commentsPath}?targetType=report&targetId=${created.report.id}`,
        { cookie: fixture.viewer.cookie },
      ),
      200,
    );
    expect(thread.items.map((comment) => comment.id)).toEqual([posted.id]);
  });

  it('作成・編集・restore・アーカイブを監査に残し、拒否もdeniedで残す', async () => {
    const created = await createReport();
    await entity(await putReport(created.report.id, { baseRevision: 1, blocks: [] }), 200);
    await putReport(created.report.id, { baseRevision: 1, blocks: [] });
    await entity(await reportAction(created.report.id, 'restore', fixture.editor, { revision: 1 }));
    await reportAction(created.report.id, 'archive', secondEditor);
    await entity(await reportAction(created.report.id, 'archive', fixture.editor), 200);
    // Archiving again changes nothing and adds no event.
    await entity(await reportAction(created.report.id, 'archive', fixture.editor), 200);
    await entity(await reportAction(created.report.id, 'unarchive', fixture.editor), 200);
    const events = await harness.database.query<{
      action: string;
      outcome: string;
      resource_id: string;
      details: Record<string, unknown>;
    }>(
      `SELECT action,outcome,resource_id,details FROM audit_events WHERE resource_type='report'
      ORDER BY occurred_at,id`,
    );
    expect(events.rows.map((event) => [event.action, event.outcome])).toEqual([
      ['report.create', 'success'],
      ['report.update', 'success'],
      ['report.update', 'denied'],
      ['report.restore', 'success'],
      ['report.archive', 'denied'],
      ['report.archive', 'success'],
      ['report.unarchive', 'success'],
    ]);
    expect(new Set(events.rows.map((event) => event.resource_id))).toEqual(
      new Set([created.report.id]),
    );
    expect(events.rows[2]!.details).toMatchObject({ code: 'report_revision_conflict' });
    expect(events.rows[3]!.details).toMatchObject({ revision: 3, restoredFromRevision: 1 });
  });

  it('バージョンの内容はDBのtriggerで変更・削除できない', async () => {
    const created = await createReport();
    for (const statement of [
      `UPDATE report_revisions SET title='changed' WHERE report_id=$1`,
      'DELETE FROM report_revisions WHERE report_id=$1',
    ])
      await expect(harness.database.query(statement, [created.report.id])).rejects.toMatchObject({
        code: '23514',
      });
    const stored = await entity<ReportDetail>(
      await request(harness.app, `${reportsPath}/${created.report.id}`, { cookie: fixture.viewer.cookie }),
      200,
    );
    expect(stored.revision.title).toBe('Weekly results');
  });

  it('ブロックの上限とidの重複は保存前に専用のcodeで拒否する', async () => {
    const duplicate = await postReport({ blocks: [markdown('a'), markdown('b')] });
    expect(duplicate.status).toBe(422);
    expect(await errorCode(duplicate)).toBe('report_block_id_duplicate');
    const tooMany = await postReport({
      blocks: Array.from({ length: 201 }, (_, index) => markdown('', `b${index}`)),
    });
    expect(tooMany.status).toBe(422);
    expect(await errorCode(tooMany)).toBe('report_too_many_blocks');
    const count = await harness.database.query('SELECT count(*)::int AS count FROM reports');
    expect(count.rows[0]).toEqual({ count: 0 });
  });

  it('sweepのRun集合は試行のRunを参照できる', async () => {
    const sweep: Sweep = await fixture.createSweep({
      name: 'grid',
      method: 'grid',
      searchSpace: { lr: { values: [0.1, 0.01] } },
      objective: { metric: 'loss', goal: 'minimize' },
      maxTrials: 2,
      parallelism: 2,
    });
    const created = await createReport([
      { ...runTable({ sweepId: sweep.id }), mode: 'snapshot' },
    ]);
    const snapshots = await entity<{ items: { data: { type: string; runs: Run[] } }[] }>(
      await request(harness.app, `${reportsPath}/${created.report.id}/snapshots`, {
        cookie: fixture.viewer.cookie,
      }),
      200,
    );
    expect(snapshots.items[0]!.data.runs.map((trialRun) => trialRun.name)).toEqual([
      'grid-0',
      'grid-1',
    ]);
  });
});
