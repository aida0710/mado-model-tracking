import type { AuditEvent, AuditEventPage, Project, SavedView } from '@mmt/contracts';
import { SAVED_VIEW_STATE_MAX_BYTES } from '@mmt/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { projectFixture } from './fixtures.js';
import { createHarness, entity, login, request, testDatabaseUrl, type Harness } from './harness.js';

type Identity = { cookie: string; userId: string };

describe.skipIf(!testDatabaseUrl)('Run一覧の保存ビュー（独立PostgreSQL）', () => {
  let harness: Harness;
  let fixture: Awaited<ReturnType<typeof projectFixture>>;
  let otherEditor: Identity;
  let projectAdmin: Identity;
  beforeAll(async () => {
    harness = await createHarness();
  });
  beforeEach(async () => {
    await harness.reset();
    fixture = await projectFixture(harness);
    otherEditor = await login(harness, 'editor2@localhost');
    projectAdmin = await login(harness, 'project-admin@localhost');
    for (const [identity, role] of [
      [otherEditor, 'editor'],
      [projectAdmin, 'admin'],
    ] as const)
      await entity(
        await request(harness.app, `${fixture.basePath}/members/${identity.userId}`, {
          method: 'PUT',
          cookie: fixture.administrator.cookie,
          body: { role },
        }),
        200,
      );
  });
  afterAll(async () => {
    await harness?.close();
  });

  function viewState(overrides: Record<string, unknown> = {}) {
    return {
      version: 1,
      experimentIds: [fixture.experiment.id],
      filter: 'metrics.loss < 0.5',
      orderBy: ['metrics.loss ASC'],
      statuses: ['finished'],
      kinds: [],
      columns: [{ key: 'metrics.loss', width: 120 }],
      groupBy: { kind: 'experiment' },
      chartPanels: {
        version: 1,
        columns: 12,
        panels: [
          {
            id: 'loss',
            metricKeys: ['loss'],
            xAxis: { kind: 'step' },
            yScale: 'log',
            smoothing: { kind: 'none', weight: 0 },
            showRange: true,
            layout: { x: 0, y: 0, w: 12, h: 4 },
          },
        ],
      },
      ...overrides,
    };
  }

  function postView(
    body: { visibility: 'private' | 'project'; name: string; state?: unknown },
    identity: Identity = fixture.editor,
    basePath = fixture.basePath,
  ) {
    return request(harness.app, `${basePath}/saved-views`, {
      method: 'POST',
      cookie: identity.cookie,
      body: { state: viewState(), ...body },
    });
  }

  async function createView(
    body: { visibility: 'private' | 'project'; name: string; state?: unknown },
    identity: Identity = fixture.editor,
  ): Promise<SavedView> {
    return entity<SavedView>(await postView(body, identity));
  }

  async function listViews(identity: Identity): Promise<SavedView[]> {
    const page = await entity<{ items: SavedView[] }>(
      await request(harness.app, `${fixture.basePath}/saved-views?page=runs`, {
        cookie: identity.cookie,
      }),
      200,
    );
    return page.items;
  }

  function getView(viewId: string, identity: Identity) {
    return request(harness.app, `${fixture.basePath}/saved-views/${viewId}`, {
      cookie: identity.cookie,
    });
  }

  function patchView(viewId: string, body: Record<string, unknown>, identity: Identity) {
    return request(harness.app, `${fixture.basePath}/saved-views/${viewId}`, {
      method: 'PATCH',
      cookie: identity.cookie,
      body,
    });
  }

  function deleteView(viewId: string, identity: Identity) {
    return request(harness.app, `${fixture.basePath}/saved-views/${viewId}`, {
      method: 'DELETE',
      cookie: identity.cookie,
    });
  }

  async function savedViewAuditEvents(): Promise<AuditEvent[]> {
    const page = await entity<AuditEventPage>(
      await request(harness.app, `/api/audit-events?limit=200`, {
        cookie: fixture.administrator.cookie,
      }),
      200,
    );
    return page.items.filter((event) => event.resourceType === 'saved_view');
  }

  async function errorCode(response: Response, status: number): Promise<string | undefined> {
    expect(response.status).toBe(status);
    return ((await response.json()) as { code?: string }).code;
  }

  it('viewerは自分用の保存ビューを作れるが、Project公開は403になる', async () => {
    const view = await createView({ visibility: 'private', name: '自分用' }, fixture.viewer);
    expect(view).toMatchObject({
      projectId: fixture.project.id,
      ownerUserId: fixture.viewer.userId,
      visibility: 'private',
      page: 'runs',
      name: '自分用',
      state: viewState(),
    });
    expect(
      await errorCode(await postView({ visibility: 'project', name: '共有' }, fixture.viewer), 403),
    ).toBe('saved_view_share_forbidden');
    // A private view stays readable after a reload: GET returns the stored state as saved.
    expect(await entity<SavedView>(await getView(view.id, fixture.viewer), 200)).toEqual(view);
  });

  it('他人の自分用ビューは一覧に出ず、GET・変更・削除は404になる', async () => {
    const mine = await createView({ visibility: 'private', name: 'editor用' });
    const shared = await createView({ visibility: 'project', name: '共有' });
    const viewerViews = await listViews(fixture.viewer);
    expect(viewerViews.map((view) => view.id)).toEqual([shared.id]);
    expect((await getView(mine.id, fixture.viewer)).status).toBe(404);
    expect((await getView(mine.id, projectAdmin)).status).toBe(404);
    expect((await patchView(mine.id, { name: '奪う' }, projectAdmin)).status).toBe(404);
    expect((await deleteView(mine.id, projectAdmin)).status).toBe(404);
    expect((await listViews(fixture.editor)).map((view) => view.name)).toEqual([
      'editor用',
      '共有',
    ]);
  });

  it('Project公開のビューはviewerが読め、Project外のUserは403になる', async () => {
    const shared = await createView({ visibility: 'project', name: '共有' });
    expect(await entity<SavedView>(await getView(shared.id, fixture.viewer), 200)).toEqual(shared);
    expect((await getView(shared.id, fixture.outsider)).status).toBe(403);
  });

  it('所有者以外のeditorはProject公開のビューを変更・削除できず、Project管理者はできる', async () => {
    const shared = await createView({ visibility: 'project', name: '共有' });
    expect(await errorCode(await patchView(shared.id, { name: '横取り' }, otherEditor), 403)).toBe(
      'saved_view_owner_required',
    );
    expect(await errorCode(await deleteView(shared.id, otherEditor), 403)).toBe(
      'saved_view_owner_required',
    );
    const renamed = await entity<SavedView>(
      await patchView(
        shared.id,
        { name: '管理者が整理', state: viewState({ filter: 'metrics.loss < 0.1' }) },
        projectAdmin,
      ),
      200,
    );
    expect(renamed).toMatchObject({
      name: '管理者が整理',
      ownerUserId: fixture.editor.userId,
      state: { filter: 'metrics.loss < 0.1' },
    });
    expect(Date.parse(renamed.updatedAt)).toBeGreaterThanOrEqual(Date.parse(shared.updatedAt));
    // Only the owner may make a shared view private; otherwise it would vanish for its owner too.
    expect(
      await errorCode(await patchView(shared.id, { visibility: 'private' }, projectAdmin), 403),
    ).toBe('saved_view_owner_required');
    expect((await deleteView(shared.id, projectAdmin)).status).toBe(204);
    expect((await getView(shared.id, fixture.editor)).status).toBe(404);
  });

  it('自分用からProject公開への変更はeditor以上だけで、所有者は自分用へ戻せる', async () => {
    const viewerView = await createView(
      { visibility: 'private', name: 'viewer用' },
      fixture.viewer,
    );
    expect(
      await errorCode(
        await patchView(viewerView.id, { visibility: 'project' }, fixture.viewer),
        403,
      ),
    ).toBe('saved_view_share_forbidden');
    const editorView = await createView({ visibility: 'private', name: '公開予定' });
    const shared = await entity<SavedView>(
      await patchView(editorView.id, { visibility: 'project' }, fixture.editor),
      200,
    );
    expect(shared.visibility).toBe('project');
    expect((await listViews(fixture.viewer)).map((view) => view.id)).toEqual([
      viewerView.id,
      editorView.id,
    ]);
    await entity(await patchView(editorView.id, { visibility: 'private' }, fixture.editor), 200);
    expect((await listViews(fixture.viewer)).map((view) => view.id)).toEqual([viewerView.id]);
  });

  it('同じ所有者の同名とProject公開どうしの同名は409、別の所有者の自分用なら同名でもよい', async () => {
    await createView({ visibility: 'private', name: '比較' });
    expect(await errorCode(await postView({ visibility: 'project', name: '比較' }), 409)).toBe(
      'saved_view_name_conflict',
    );
    await createView({ visibility: 'private', name: '比較' }, otherEditor);
    await createView({ visibility: 'project', name: '公開比較' }, otherEditor);
    expect(await errorCode(await postView({ visibility: 'project', name: '公開比較' }), 409)).toBe(
      'saved_view_name_conflict',
    );
    const other = await createView({ visibility: 'private', name: '別名' });
    expect(await errorCode(await patchView(other.id, { name: '比較' }, fixture.editor), 409)).toBe(
      'saved_view_name_conflict',
    );
  });

  it('64KiBを超える状態・未知のversion・検索できないfilterは422で保存しない', async () => {
    // Columns alone stay below the limit (200 x 300 characters), so wide chart panels exceed it.
    const basePanel = viewState().chartPanels.panels[0]!;
    const oversized = viewState({
      chartPanels: {
        version: 1,
        columns: 12,
        panels: Array.from({ length: 20 }, (_, index) => ({
          ...basePanel,
          id: `panel-${index}`,
          metricKeys: Array.from({ length: 20 }, (_, key) => `${'m'.repeat(200)}${key}`),
        })),
      },
    });
    expect(JSON.stringify(oversized).length).toBeGreaterThan(SAVED_VIEW_STATE_MAX_BYTES);
    const cases: [unknown, string][] = [
      [oversized, 'saved_view_state_too_large'],
      [viewState({ version: 2 }), 'saved_view_state_unsupported_version'],
      [viewState({ filter: 'metrics.loss <' }), 'saved_view_filter_invalid'],
      [viewState({ chartPanels: { version: 1, columns: 12 } }), 'invalid_request'],
    ];
    for (const [state, code] of cases)
      expect(
        await errorCode(await postView({ visibility: 'private', name: '壊れた', state }), 422),
      ).toBe(code);
    const view = await createView({ visibility: 'private', name: '正しい' });
    expect(
      await errorCode(
        await patchView(view.id, { state: viewState({ filter: 'params.lr ==' }) }, fixture.editor),
        422,
      ),
    ).toBe('saved_view_filter_invalid');
    expect(await listViews(fixture.editor)).toEqual([view]);
  });

  it('他Projectのビューは404、他Projectのexperimentを含む状態は422になる', async () => {
    const shared = await createView({ visibility: 'project', name: '共有' });
    const other = await entity<Project>(
      await request(harness.app, '/api/projects', {
        method: 'POST',
        cookie: fixture.administrator.cookie,
        body: { name: 'Other Project' },
      }),
    );
    await entity(
      await request(harness.app, `/api/projects/${other.id}/members/${fixture.editor.userId}`, {
        method: 'PUT',
        cookie: fixture.administrator.cookie,
        body: { role: 'editor' },
      }),
      200,
    );
    const otherBase = `/api/projects/${other.id}`;
    expect(
      (
        await request(harness.app, `${otherBase}/saved-views/${shared.id}`, {
          cookie: fixture.editor.cookie,
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await request(harness.app, `${otherBase}/saved-views/${shared.id}`, {
          method: 'PATCH',
          cookie: fixture.editor.cookie,
          body: { name: '移動' },
        })
      ).status,
    ).toBe(404);
    expect(
      await errorCode(
        await postView({ visibility: 'private', name: '混在' }, fixture.editor, otherBase),
        422,
      ),
    ).toBe('saved_view_experiment_not_found');
  });

  it('監査はProject公開の作成・変更・削除と拒否だけを記録し、自分用は記録しない', async () => {
    const mine = await createView({ visibility: 'private', name: '自分用' });
    await entity(await patchView(mine.id, { name: '自分用2' }, fixture.editor), 200);
    expect((await deleteView(mine.id, fixture.editor)).status).toBe(204);
    await postView({ visibility: 'private', name: 'viewer用' }, fixture.viewer);
    expect(await savedViewAuditEvents()).toEqual([]);

    const shared = await createView({ visibility: 'project', name: '共有' });
    await entity(await patchView(shared.id, { name: '共有2' }, fixture.editor), 200);
    await patchView(shared.id, { name: '横取り' }, otherEditor);
    await postView({ visibility: 'project', name: 'viewer共有' }, fixture.viewer);
    expect((await deleteView(shared.id, projectAdmin)).status).toBe(204);
    const events = (await savedViewAuditEvents()).reverse();
    expect(events.map((event) => [event.action, event.outcome, event.resourceId ?? null])).toEqual([
      ['saved_view.create', 'success', shared.id],
      ['saved_view.update', 'success', shared.id],
      ['saved_view.update', 'denied', shared.id],
      ['saved_view.create', 'denied', null],
      ['saved_view.delete', 'success', shared.id],
    ]);
    expect(events[1]!.details).toMatchObject({
      name: '共有2',
      changedFields: ['name'],
      visibility: 'project',
      byOwner: true,
    });
    expect(events[4]!.details).toMatchObject({ name: '共有2', byOwner: false });
    expect(JSON.stringify(events)).not.toContain('metrics.loss');
  });

  it('Job限定token以外のtokenはscopeで書き込みを判定する', async () => {
    const minted = await entity<{ token: string }>(
      await request(harness.app, '/api/tokens', {
        method: 'POST',
        cookie: fixture.viewer.cookie,
        body: {
          name: 'read only',
          kind: 'personal',
          projectId: fixture.project.id,
          scopes: ['read'],
        },
      }),
    );
    const response = await request(harness.app, `${fixture.basePath}/saved-views`, {
      method: 'POST',
      token: minted.token,
      body: { visibility: 'private', name: 'token', state: viewState() },
    });
    expect(await errorCode(response, 403)).toBe('insufficient_scope');
    expect(
      (await request(harness.app, `${fixture.basePath}/saved-views`, { token: minted.token }))
        .status,
    ).toBe(200);
  });
});
