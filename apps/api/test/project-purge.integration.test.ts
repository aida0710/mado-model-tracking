import { createHash } from 'node:crypto';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AdminProject, Artifact, Job, Run, ServiceAccount } from '@mmt/contracts';
import {
  PROJECT_PURGE_KEPT_TABLES,
  PROJECT_PURGE_STEPS,
} from '../src/repositories/projectPurgeRepository.js';
import { executionFixture, projectFixture } from './fixtures.js';
import { createHarness, entity, request, testDatabaseUrl, type Harness } from './harness.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = '2026-10-11T00:00:00.000Z';
const PURGED_TABLES = new Set(PROJECT_PURGE_STEPS.map((step) => step.table));
const KEPT_TABLES = new Set(Object.keys(PROJECT_PURGE_KEPT_TABLES));

interface ForeignKey {
  child: string;
  parent: string;
  name: string;
  deferrable: boolean;
  onDelete: 'a' | 'r' | 'c' | 'n' | 'd';
}

describe.skipIf(!testDatabaseUrl)('Projectの完全な削除（独立PostgreSQL）', () => {
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

  async function baseTablesWithProjectId(): Promise<string[]> {
    const found = await harness.database.query<{ table_name: string }>(
      `SELECT c.table_name FROM information_schema.columns c
      JOIN information_schema.tables t ON t.table_schema=c.table_schema AND t.table_name=c.table_name
      WHERE c.table_schema=current_schema() AND c.column_name='project_id' AND t.table_type='BASE TABLE'
      ORDER BY c.table_name`,
    );
    return found.rows.map((row) => row.table_name);
  }

  async function foreignKeys(): Promise<ForeignKey[]> {
    const found = await harness.database.query<ForeignKey>(
      `SELECT c.conrelid::regclass::text AS child,c.confrelid::regclass::text AS parent,c.conname AS name,
        c.condeferrable AS deferrable,c.confdeltype AS "onDelete"
      FROM pg_constraint c WHERE c.contype='f' AND c.connamespace=current_schema()::regnamespace`,
    );
    return found.rows;
  }

  /** Rows of each purged table that belong to the Project, by the purge's own conditions. */
  async function rowCounts(projectId: string): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};
    for (const step of PROJECT_PURGE_STEPS) {
      const counted = await harness.database.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM ${step.table} WHERE ${step.rowsOfProject}`,
        [projectId],
      );
      counts[step.table] = counted.rows[0]!.count;
    }
    return counts;
  }

  async function totalCounts(): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};
    for (const table of PURGED_TABLES) {
      const counted = await harness.database.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM ${table}`,
      );
      counts[table] = counted.rows[0]!.count;
    }
    return counts;
  }

  async function blobExists(storageKey: string): Promise<boolean> {
    return access(path.join(harness.artifactDirectory, storageKey)).then(
      () => true,
      () => false,
    );
  }

  /**
   * A Project with rows in the tables that need care: history that only a purge may delete
   * (checkpoints, resume events, alias events, report revisions), rows without project_id
   * (metrics, logs, aliases), a pending Artifact deletion, a canceled Job, Service Account and
   * Project-limited tokens, and a group binding.
   */
  async function populatedProject() {
    const fixture = await executionFixture(harness);
    const { basePath, editor, administrator } = fixture;
    const send = async <T>(
      endpoint: string,
      options: { method?: string; cookie?: string; body?: unknown; binary?: string },
      expectedStatus = 201,
    ): Promise<T> => {
      const response = await request(harness.app, `${basePath}${endpoint}`, {
        cookie: editor.cookie,
        ...options,
      });
      expect(response.status, `${options.method} ${endpoint}`).toBe(expectedStatus);
      return (expectedStatus === 204 ? undefined : await response.json()) as T;
    };

    const inference = await fixture.newRun('Canceled inference');
    const job = await send<Job>('/jobs', {
      method: 'POST',
      body: { runId: inference.id, targetId: fixture.target.id, gpuIds: [] },
    });
    await send(`/jobs/${job.id}/cancel`, { method: 'POST' }, 200);

    const training = await send<Run>('/runs', {
      method: 'POST',
      body: { experimentId: fixture.experiment.id, name: 'Purged training', kind: 'training' },
    });
    const runPath = `/runs/${training.id}`;
    await send(runPath, { method: 'PATCH', body: { status: 'running' } }, 200);
    await send(
      `${runPath}/metrics`,
      {
        method: 'POST',
        body: { metrics: [{ name: 'loss', value: 0.5, step: 1, timestamp: NOW }] },
      },
      204,
    );
    await send(
      `${runPath}/logs`,
      {
        method: 'POST',
        body: { entries: [{ timestamp: NOW, level: 'info', message: 'epoch 1' }] },
      },
      204,
    );
    const weights = await send<Artifact>(`${runPath}/artifacts?path=model.pt`, {
      method: 'PUT',
      binary: 'weights',
    });
    const replaced = await send<Artifact>(`${runPath}/artifacts?path=old.txt`, {
      method: 'PUT',
      binary: 'old',
    });
    await send(
      `/artifacts/${replaced.id}`,
      { method: 'DELETE', cookie: administrator.cookie },
      200,
    );
    await send(`${runPath}/checkpoints`, {
      method: 'POST',
      body: {
        step: 1,
        artifactId: weights.id,
        manifest: {
          files: [
            {
              path: 'model.pt',
              sha256: createHash('sha256').update('weights').digest('hex'),
              size: 7,
            },
          ],
        },
      },
    });
    await send(runPath, { method: 'PATCH', body: { status: 'finished' } }, 200);
    await send(`${runPath}/resume`, { method: 'POST', body: {} }, 200);

    await send(
      `/models/${fixture.model.id}/aliases/production`,
      {
        method: 'PUT',
        body: { versionId: fixture.modelVersion.id },
      },
      200,
    );
    await send('/reports', {
      method: 'POST',
      body: { title: 'Purged report', blocks: [{ type: 'markdown', id: 'intro', text: '# gone' }] },
    });
    await send('/comments', {
      method: 'POST',
      body: { targetType: 'run', targetId: training.id, body: 'goes with the Project' },
    });
    const robot = await send<ServiceAccount>('/service-accounts', {
      method: 'POST',
      cookie: administrator.cookie,
      body: { name: 'robot', role: 'editor' },
    });
    await send(`/service-accounts/${robot.id}/tokens`, {
      method: 'POST',
      cookie: administrator.cookie,
      body: { name: 'robot token', scopes: ['read'] },
    });
    await entity(
      await request(harness.app, '/api/tokens', {
        method: 'POST',
        cookie: editor.cookie,
        body: {
          name: 'Limited',
          kind: 'personal',
          projectId: fixture.project.id,
          scopes: ['read'],
        },
      }),
    );
    await send(
      '/group-bindings/ml-team',
      {
        method: 'PUT',
        cookie: administrator.cookie,
        body: { role: 'viewer' },
      },
      200,
    );
    return { ...fixture, robot };
  }

  /** Another Project with a Run, a metric and an Artifact, which a purge must not touch. */
  async function bystanderProject() {
    const fixture = await projectFixture(harness);
    const run = await entity<Run>(
      await request(harness.app, `${fixture.basePath}/runs`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: { experimentId: fixture.experiment.id, name: 'Bystander', kind: 'training' },
      }),
    );
    const metrics = await request(harness.app, `${fixture.basePath}/runs/${run.id}/metrics`, {
      method: 'POST',
      cookie: fixture.editor.cookie,
      body: { metrics: [{ name: 'loss', value: 0.1, step: 1, timestamp: NOW }] },
    });
    expect(metrics.status).toBe(204);
    const artifact = await entity<Artifact>(
      await request(harness.app, `${fixture.basePath}/runs/${run.id}/artifacts?path=kept.txt`, {
        method: 'PUT',
        cookie: fixture.editor.cookie,
        binary: 'kept',
      }),
    );
    return { ...fixture, artifact };
  }

  function purge(projectId: string, cookie: string): Promise<Response> {
    return request(harness.app, `/api/admin/projects/${projectId}`, { method: 'DELETE', cookie });
  }

  it('project_idを持つ表はすべて完全な削除の対象か、残す理由を書いた表で、対象の表はすべて実在する', async () => {
    const tables = await baseTablesWithProjectId();
    expect(tables.filter((table) => !PURGED_TABLES.has(table) && !KEPT_TABLES.has(table))).toEqual(
      [],
    );
    const existing = await harness.database.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema=current_schema() AND table_type='BASE TABLE'",
    );
    const names = new Set(existing.rows.map((row) => row.table_name));
    expect([...PURGED_TABLES, ...KEPT_TABLES].filter((table) => !names.has(table))).toEqual([]);
  });

  it('削除する行を指す外部キーは削除の対象の表からだけで、commitまで検査を遅らせられる', async () => {
    const keys = await foreignKeys();
    const intoPurged = keys.filter((key) => PURGED_TABLES.has(key.parent));
    // A row outside the purge (a kept table) pointing at a purged row would block the commit; only
    // an ON DELETE CASCADE child may be left to the database.
    expect(
      intoPurged
        .filter((key) => !PURGED_TABLES.has(key.child) && key.onDelete !== 'c')
        .map((key) => `${key.child}.${key.name}`),
    ).toEqual([]);
    // Rows of a Project reference each other in cycles; the purge needs every check deferrable.
    expect(intoPurged.filter((key) => !key.deferrable).map((key) => key.name)).toEqual([]);
  });

  it('アーカイブしたProjectを完全に削除するとそのProjectの行だけが消え、墓標・監査・失効したtokenが残る', async () => {
    const purged = await populatedProject();
    const bystander = await bystanderProject();
    const projectId = purged.project.id;
    const purgedRows = await rowCounts(projectId);
    for (const table of [
      'metrics',
      'run_logs',
      'model_aliases',
      'report_revisions',
      'artifacts',
      'artifact_deletions',
      'run_checkpoints',
      'run_resume_events',
      'model_alias_events',
      'jobs',
      'comments',
      'reports',
      'project_group_bindings',
      'project_members',
      'runs',
      'model_versions',
      'code_versions',
    ])
      expect(purgedRows[table], table).toBeGreaterThan(0);
    const bystanderRows = await rowCounts(bystander.project.id);
    const purgedKeys = (
      await harness.database.query<{ storage_key: string }>(
        'SELECT storage_key FROM artifacts WHERE project_id=$1',
        [projectId],
      )
    ).rows.map((row) => row.storage_key);
    for (const key of purgedKeys) expect(await blobExists(key)).toBe(true);

    expect((await purge(projectId, purged.administrator.cookie)).status).toBe(409);
    expect(
      (
        await request(harness.app, `/api/projects/${projectId}/archive`, {
          method: 'POST',
          cookie: purged.administrator.cookie,
        })
      ).status,
    ).toBe(204);
    // Archived is not enough: history rows still refuse to be deleted outside a purge.
    await expect(
      harness.database.query('DELETE FROM model_alias_events WHERE project_id=$1', [projectId]),
    ).rejects.toMatchObject({ code: '23514' });
    expect((await purge(projectId, purged.administrator.cookie)).status).toBe(204);

    // Every row of the purged Project is gone, and the other Project still has all of its rows.
    expect(await totalCounts()).toEqual(bystanderRows);
    expect(await rowCounts(bystander.project.id)).toEqual(bystanderRows);
    const tombstone = await harness.database.query(
      'SELECT name,description,archived_at IS NOT NULL AS archived,purged_at IS NOT NULL AS purged FROM projects WHERE id=$1',
      [projectId],
    );
    expect(tombstone.rows).toEqual([
      { name: 'Test Project', description: '', archived: true, purged: true },
    ]);
    const tokens = await harness.database.query(
      'SELECT count(*)::int AS total,count(*) FILTER (WHERE revoked_at IS NULL)::int AS live FROM api_tokens WHERE project_id=$1',
      [projectId],
    );
    expect(tokens.rows[0]).toEqual({ total: 3, live: 0 });
    const robot = await harness.database.query(
      'SELECT u.status,d.disabled_at IS NOT NULL AS disabled FROM users u JOIN service_account_details d ON d.user_id=u.id WHERE u.id=$1',
      [purged.robot.id],
    );
    expect(robot.rows).toEqual([{ status: 'disabled', disabled: true }]);
    const audit = await harness.database.query(
      "SELECT action,details FROM audit_events WHERE project_id=$1 AND outcome='success' ORDER BY occurred_at,id",
      [projectId],
    );
    expect(audit.rows[0]).toMatchObject({ action: 'project.create' });
    expect(audit.rows.at(-1)).toEqual({
      action: 'project.purge',
      details: {
        name: 'Test Project',
        queuedBlobs: purgedKeys.length,
        deletedRows: Object.values(purgedRows).reduce((sum, count) => sum + count, 0),
      },
    });

    // Gone for the administrators too: not listed, not restorable, not purgeable twice.
    const listed = await entity<{ items: AdminProject[] }>(
      await request(harness.app, '/api/admin/projects?includeArchived=true', {
        cookie: purged.administrator.cookie,
      }),
      200,
    );
    expect(listed.items.map((item) => item.id)).toEqual([bystander.project.id]);
    expect(
      (
        await request(harness.app, `/api/admin/projects/${projectId}/restore`, {
          method: 'POST',
          cookie: purged.administrator.cookie,
        })
      ).status,
    ).toBe(404);
    expect((await purge(projectId, purged.administrator.cookie)).status).toBe(404);

    // The blobs wait out the grace period like deleted Artifacts, then the collector removes them.
    const collector = harness.artifactGarbageCollector;
    expect(await collector.collect(new Date())).toMatchObject({ removedBlobs: 0 });
    for (const key of purgedKeys) expect(await blobExists(key)).toBe(true);
    const afterGrace = new Date(Date.now() + (harness.config.artifactDeleteGraceDays + 1) * DAY_MS);
    expect(await collector.collect(afterGrace)).toMatchObject({
      removedBlobs: purgedKeys.length,
      failedBlobs: 0,
    });
    for (const key of purgedKeys) expect(await blobExists(key)).toBe(false);
    expect(await blobExists(bystander.artifact.storageKey)).toBe(true);
    const pending = await harness.database.query(
      'SELECT count(*)::int AS count FROM purged_project_blobs WHERE removed_at IS NULL',
    );
    expect(pending.rows[0]).toEqual({ count: 0 });
  });
});
