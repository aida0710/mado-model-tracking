import type {
  AuditEvent,
  AuditEventPage,
  Comment,
  CommentPage,
  ModelVersion,
  Project,
} from '@mmt/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { executionFixture } from './fixtures.js';
import { createHarness, entity, login, request, testDatabaseUrl, type Harness } from './harness.js';
import { trackingClient } from './mlflow-tracking-fixtures.js';

describe.skipIf(!testDatabaseUrl)('Run・モデルバージョンのスレッド形式コメント（独立PostgreSQL）', () => {
  let harness: Harness;
  let fixture: Awaited<ReturnType<typeof executionFixture>>;
  let runId: string;
  beforeAll(async () => {
    harness = await createHarness();
  });
  beforeEach(async () => {
    await harness.reset();
    fixture = await executionFixture(harness);
    runId = (await fixture.newRun()).id;
  });
  afterAll(async () => {
    await harness?.close();
  });

  function postComment(
    body: { targetType?: string; targetId?: string; parentCommentId?: string; body: string },
    authorization: { cookie?: string; token?: string } = { cookie: fixture.editor.cookie },
  ) {
    return request(harness.app, `${fixture.basePath}/comments`, {
      method: 'POST',
      ...authorization,
      body: { targetType: 'run', targetId: runId, ...body },
    });
  }

  async function createComment(
    body: { targetType?: string; targetId?: string; parentCommentId?: string; body: string },
    cookie = fixture.editor.cookie,
  ): Promise<Comment> {
    return entity<Comment>(await postComment(body, { cookie }));
  }

  async function listComments(
    query: Record<string, string> = {},
    cookie = fixture.viewer.cookie,
  ): Promise<CommentPage> {
    const search = new URLSearchParams({ targetType: 'run', targetId: runId, ...query });
    return entity<CommentPage>(
      await request(harness.app, `${fixture.basePath}/comments?${search}`, { cookie }),
      200,
    );
  }

  function changeComment(
    commentId: string,
    change: { method: 'PATCH' | 'DELETE'; cookie: string; body?: string },
  ) {
    return request(harness.app, `${fixture.basePath}/comments/${commentId}`, {
      method: change.method,
      cookie: change.cookie,
      ...(change.body !== undefined ? { body: { body: change.body } } : {}),
    });
  }

  async function auditEvents(action: string): Promise<AuditEvent[]> {
    const page = await entity<AuditEventPage>(
      await request(harness.app, `/api/audit-events?action=${action}&limit=200`, {
        cookie: fixture.administrator.cookie,
      }),
      200,
    );
    return page.items;
  }

  async function mintEditorToken(scopes: string[]): Promise<string> {
    const minted = await entity<{ token: string }>(
      await request(harness.app, '/api/tokens', {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: { name: 'Comment CI', kind: 'personal', projectId: fixture.project.id, scopes },
      }),
    );
    return minted.token;
  }

  it('viewerは読めるが投稿は403になる', async () => {
    await createComment({ body: '最初のコメント' });
    expect((await postComment({ body: 'viewer' }, { cookie: fixture.viewer.cookie })).status).toBe(
      403,
    );
    const page = await listComments();
    expect(page.items.map((comment) => comment.body)).toEqual(['最初のコメント']);
    expect(page.items[0]).toMatchObject({
      projectId: fixture.project.id,
      targetType: 'run',
      targetId: runId,
      parentCommentId: null,
      author: { id: fixture.editor.userId },
      editedAt: null,
      deleted: false,
    });
    expect(
      (
        await request(
          harness.app,
          `${fixture.basePath}/comments?targetType=run&targetId=${runId}`,
          { cookie: fixture.outsider.cookie },
        )
      ).status,
    ).toBe(403);
  });

  it('返信への返信は元のスレッドへの返信になり、一覧はスレッド順に並ぶ', async () => {
    const first = await createComment({ body: 'thread 1' });
    const second = await createComment({ body: 'thread 2' });
    const reply = await createComment({ parentCommentId: first.id, body: 'reply 1-1' });
    const nested = await createComment({ parentCommentId: reply.id, body: 'reply 1-2' });
    expect(reply.parentCommentId).toBe(first.id);
    expect(nested.parentCommentId).toBe(first.id);

    const page = await listComments();
    expect(page.items.map((comment) => comment.id)).toEqual([
      first.id,
      reply.id,
      nested.id,
      second.id,
    ]);
    expect(page.nextCursor).toBeNull();
  });

  it('別の対象のコメントへは返信できない', async () => {
    const otherRunId = (await fixture.newRun('Other')).id;
    const elsewhere = await createComment({ targetId: otherRunId, body: 'elsewhere' });
    const response = await postComment({ parentCommentId: elsewhere.id, body: 'mismatch' });
    expect(response.status).toBe(422);
    expect(((await response.json()) as { code: string }).code).toBe('comment_parent_mismatch');
  });

  it('作成者は編集でき、他人の編集は403になる', async () => {
    const comment = await createComment({ body: 'before' });
    const edited = await entity<Comment>(
      await changeComment(comment.id, {
        method: 'PATCH',
        cookie: fixture.editor.cookie,
        body: 'after',
      }),
      200,
    );
    expect(edited.body).toBe('after');
    expect(edited.editedAt).not.toBeNull();

    const forbidden = await changeComment(comment.id, {
      method: 'PATCH',
      cookie: fixture.administrator.cookie,
      body: 'admin edit',
    });
    expect(forbidden.status).toBe(403);
    expect(((await forbidden.json()) as { code: string }).code).toBe('comment_author_required');
  });

  it('Project adminは他人のコメントを削除でき、別のeditorは削除できない', async () => {
    const secondEditor = await login(harness, 'editor2@localhost');
    await entity(
      await request(harness.app, `${fixture.basePath}/members/${secondEditor.userId}`, {
        method: 'PUT',
        cookie: fixture.administrator.cookie,
        body: { role: 'editor' },
      }),
      200,
    );
    const comment = await createComment({ body: 'to delete' });
    expect(
      (await changeComment(comment.id, { method: 'DELETE', cookie: secondEditor.cookie })).status,
    ).toBe(403);
    expect(
      (await changeComment(comment.id, { method: 'DELETE', cookie: fixture.administrator.cookie }))
        .status,
    ).toBe(204);
  });

  it('削除済みのコメントはbodyを返さずスレッドの位置を残し、編集は409になる', async () => {
    const root = await createComment({ body: 'root body' });
    const reply = await createComment({ parentCommentId: root.id, body: 'reply body' });
    expect(
      (await changeComment(root.id, { method: 'DELETE', cookie: fixture.editor.cookie })).status,
    ).toBe(204);
    // A retried deletion succeeds without recording a second deletion.
    expect(
      (await changeComment(root.id, { method: 'DELETE', cookie: fixture.editor.cookie })).status,
    ).toBe(204);

    const page = await listComments();
    expect(page.items.map(({ id, body, deleted }) => ({ id, body, deleted }))).toEqual([
      { id: root.id, body: null, deleted: true },
      { id: reply.id, body: 'reply body', deleted: false },
    ]);
    expect(
      (
        await changeComment(root.id, {
          method: 'PATCH',
          cookie: fixture.editor.cookie,
          body: 'revive',
        })
      ).status,
    ).toBe(409);
    expect(await auditEvents('comment.delete')).toHaveLength(1);
  });

  it('他Projectの対象は404、存在しない対象も404になる', async () => {
    const other = await entity<Project>(
      await request(harness.app, '/api/projects', {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: { name: 'Other Project' },
      }),
    );
    const crossProject = await request(harness.app, `/api/projects/${other.id}/comments`, {
      method: 'POST',
      cookie: fixture.editor.cookie,
      body: { targetType: 'run', targetId: runId, body: 'cross' },
    });
    expect(crossProject.status).toBe(404);
    expect(
      (
        await request(
          harness.app,
          `/api/projects/${other.id}/comments?targetType=model_version&targetId=${fixture.modelVersion.id}`,
          { cookie: fixture.editor.cookie },
        )
      ).status,
    ).toBe(404);
    expect(
      (await postComment({ targetId: '00000000-0000-4000-8000-000000000000', body: 'x' })).status,
    ).toBe(404);
  });

  it('削除済みのRun・モデルバージョンへの投稿は409になる', async () => {
    await entity(
      await trackingClient(harness.app, fixture).post('/runs/delete', { run_id: runId }),
      200,
    );
    const runResponse = await postComment({ body: 'late' });
    expect(runResponse.status).toBe(409);
    expect(((await runResponse.json()) as { code: string }).code).toBe('comment_target_deleted');

    // MLflow addresses versions by number, so delete an auto-numbered version.
    const numbered = await entity<ModelVersion>(
      await request(harness.app, `${fixture.basePath}/models/${fixture.model.id}/versions`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: { defaultCodeVersionId: fixture.codeVersion.id },
      }),
    );
    await entity(
      await request(
        harness.app,
        `/api/mlflow/projects/${fixture.project.id}/api/2.0/mlflow/model-versions/delete`,
        {
          method: 'DELETE',
          cookie: fixture.editor.cookie,
          body: { name: fixture.model.name, version: numbered.version },
        },
      ),
      200,
    );
    expect(
      (await postComment({ targetType: 'model_version', targetId: numbered.id, body: 'late' }))
        .status,
    ).toBe(409);
  });

  it('モデルバージョンへの投稿にはregistry:writeが要り、runs:writeだけのtokenは403になる', async () => {
    const runsOnly = await mintEditorToken(['read', 'runs:write']);
    const versionTarget = { targetType: 'model_version', targetId: fixture.modelVersion.id };
    expect((await postComment({ ...versionTarget, body: 'x' }, { token: runsOnly })).status).toBe(
      403,
    );
    expect((await postComment({ body: 'run comment' }, { token: runsOnly })).status).toBe(201);

    const registry = await mintEditorToken(['read', 'registry:write']);
    expect(
      (await postComment({ ...versionTarget, body: 'version comment' }, { token: registry }))
        .status,
    ).toBe(201);
  });

  it('存在しないreportへの投稿は404になる（reportの対象はreports-apiが登録する）', async () => {
    const response = await postComment({
      targetType: 'report',
      targetId: '00000000-0000-4000-8000-000000000000',
      body: 'x',
    });
    expect(response.status).toBe(404);
  });

  it('同一時刻のコメントでもcursorで重複・欠落なく全件を辿れる', async () => {
    const roots: Comment[] = [];
    for (const body of ['a', 'b', 'c', 'd', 'e']) roots.push(await createComment({ body }));
    const reply = await createComment({ parentCommentId: roots[0]!.id, body: 'a-reply' });
    // Same created_at for every comment, so ordering falls back to the thread and comment ids.
    await harness.database.query(
      "UPDATE comments SET created_at='2026-10-08T00:00:00Z' WHERE project_id=$1",
      [fixture.project.id],
    );

    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page: CommentPage = await listComments({ limit: '2', ...(cursor ? { cursor } : {}) });
      expect(page.items.length).toBeLessThanOrEqual(2);
      seen.push(...page.items.map((comment) => comment.id));
      cursor = page.nextCursor;
    } while (cursor);

    expect(seen).toHaveLength(6);
    expect(new Set(seen).size).toBe(6);
    // The reply directly follows its root even though both share the same created_at.
    expect(seen[seen.indexOf(roots[0]!.id) + 1]).toBe(reply.id);
    const rootOrder = roots.map((root) => root.id).sort();
    expect(seen.filter((id) => id !== reply.id)).toEqual(rootOrder);
  });

  it('監査はcomment.create/update/deleteを残し、本文を入れない', async () => {
    const comment = await createComment({ body: 'audit-body-create' });
    await entity(
      await changeComment(comment.id, {
        method: 'PATCH',
        cookie: fixture.editor.cookie,
        body: 'audit-body-update',
      }),
      200,
    );
    await changeComment(comment.id, { method: 'DELETE', cookie: fixture.editor.cookie });

    for (const action of ['comment.create', 'comment.update', 'comment.delete']) {
      const events = await auditEvents(action);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        actorUserId: fixture.editor.userId,
        outcome: 'success',
        resourceType: 'comment',
        resourceId: comment.id,
        projectId: fixture.project.id,
        details: { targetType: 'run', targetId: runId },
      });
    }
    const stored = await harness.database.query<{ details: string }>(
      "SELECT details::text AS details FROM audit_events WHERE action LIKE 'comment.%'",
    );
    for (const row of stored.rows) expect(row.details).not.toContain('audit-body');
  });
});
