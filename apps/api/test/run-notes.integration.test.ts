import {
  RUN_NOTE_MAX_LENGTH,
  RUN_NOTE_TAG,
  type AuditEventPage,
  type Job,
  type Run,
  type RunNote,
} from '@mmt/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Principal } from '../src/auth/principal.js';
import { executionFixture } from './fixtures.js';
import { createHarness, entity, request, testDatabaseUrl, type Harness } from './harness.js';
import { trackingClient } from './mlflow-tracking-fixtures.js';

describe.skipIf(!testDatabaseUrl)('Runの説明文（独立PostgreSQL）', () => {
  let harness: Harness;
  let fixture: Awaited<ReturnType<typeof executionFixture>>;
  beforeAll(async () => {
    harness = await createHarness();
  });
  beforeEach(async () => {
    await harness.reset();
    fixture = await executionFixture(harness);
  });
  afterAll(async () => {
    await harness?.close();
  });

  function putNote(runId: string, content: string, cookie = fixture.editor.cookie) {
    return request(harness.app, `${fixture.basePath}/runs/${runId}/note`, {
      method: 'PUT',
      cookie,
      body: { content },
    });
  }

  async function nativeRun(runId: string): Promise<Run> {
    return entity<Run>(
      await request(harness.app, `${fixture.basePath}/runs/${runId}`, {
        cookie: fixture.viewer.cookie,
      }),
      200,
    );
  }

  it('PUTした説明文がnativeのtagsとMLflow get-runのmlflow.note.contentに同じ値で出る', async () => {
    const run = await fixture.newRun();
    const content = '# 学習条件\n\n- lr: `1e-4`\n- 日本語の説明も入る';
    expect(await entity<RunNote>(await putNote(run.id, content), 200)).toEqual({
      runId: run.id,
      content,
    });

    expect((await nativeRun(run.id)).tags[RUN_NOTE_TAG]).toBe(content);
    const mlflowRun = await trackingClient(harness.app, fixture).getRun(run.id);
    expect(mlflowRun.data.tags).toContainEqual({ key: RUN_NOTE_TAG, value: content });
  });

  it('MLflow set-tagで書いた説明文をnativeで読め、ほかのtagを残したまま上書きできる', async () => {
    const client = trackingClient(harness.app, fixture);
    const mlflowRun = await client.createRun({ tags: [{ key: 'team', value: 'speech' }] });
    const runId = mlflowRun.info.run_id;
    await entity(
      await client.post('/runs/set-tag', { run_id: runId, key: RUN_NOTE_TAG, value: 'from sdk' }),
      200,
    );
    expect((await nativeRun(runId)).tags[RUN_NOTE_TAG]).toBe('from sdk');

    await entity(await putNote(runId, 'from web'), 200);
    const tags = (await nativeRun(runId)).tags;
    expect(tags[RUN_NOTE_TAG]).toBe('from web');
    expect(tags.team).toBe('speech');
  });

  it('8000文字は保存でき、8001文字は422で変更しない', async () => {
    const run = await fixture.newRun();
    const longest = 'あ'.repeat(RUN_NOTE_MAX_LENGTH);
    await entity(await putNote(run.id, longest), 200);
    const rejected = await putNote(run.id, 'あ'.repeat(RUN_NOTE_MAX_LENGTH + 1));
    expect(rejected.status).toBe(422);
    expect((await nativeRun(run.id)).tags[RUN_NOTE_TAG]).toBe(longest);
  });

  it('空文字で説明文のtagが消え、MLflowからも見えなくなる', async () => {
    const run = await fixture.newRun();
    await entity(await putNote(run.id, 'temporary'), 200);
    expect(await entity<RunNote>(await putNote(run.id, ''), 200)).toEqual({
      runId: run.id,
      content: '',
    });
    expect(RUN_NOTE_TAG in (await nativeRun(run.id)).tags).toBe(false);
    const mlflowRun = await trackingClient(harness.app, fixture).getRun(run.id);
    expect(mlflowRun.data.tags?.some((tag) => tag.key === RUN_NOTE_TAG) ?? false).toBe(false);
  });

  it('Jobが終端になったRunでもnativeでは説明文を編集できる', async () => {
    const run = await fixture.newRun();
    const job = await entity<Job>(
      await request(harness.app, `${fixture.basePath}/jobs`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: { runId: run.id, targetId: fixture.target.id },
      }),
    );
    await entity(
      await request(harness.app, `${fixture.basePath}/jobs/${job.id}/cancel`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
      }),
      200,
    );
    expect((await nativeRun(run.id)).status).toBe('canceled');

    await entity(await putNote(run.id, '途中で止めた理由: データ不備'), 200);
    expect((await nativeRun(run.id)).tags[RUN_NOTE_TAG]).toBe('途中で止めた理由: データ不備');
  });

  it('viewerと非メンバーは403、別ProjectのURLからは404、削除済みRunは409', async () => {
    const run = await fixture.newRun();
    expect((await putNote(run.id, 'x', fixture.viewer.cookie)).status).toBe(403);
    expect((await putNote(run.id, 'x', fixture.outsider.cookie)).status).toBe(403);

    const other = await entity<{ id: string }>(
      await request(harness.app, '/api/projects', {
        method: 'POST',
        cookie: fixture.outsider.cookie,
        body: { name: 'Other Project' },
      }),
    );
    const crossProject = await request(
      harness.app,
      `/api/projects/${other.id}/runs/${run.id}/note`,
      { method: 'PUT', cookie: fixture.outsider.cookie, body: { content: 'x' } },
    );
    expect(crossProject.status).toBe(404);

    await entity(
      await trackingClient(harness.app, fixture).post('/runs/delete', { run_id: run.id }),
      200,
    );
    const deleted = await putNote(run.id, 'x');
    expect(deleted.status).toBe(409);
    expect(((await deleted.json()) as { code: string }).code).toBe('run_deleted');
  });

  it('Job限定tokenのprincipalは403で拒否する', async () => {
    const run = await fixture.newRun();
    const minted = await entity<{ token: string; item: { id: string } }>(
      await request(harness.app, '/api/tokens', {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: {
          name: 'Job stand-in',
          kind: 'personal',
          projectId: fixture.project.id,
          scopes: ['read', 'runs:write'],
        },
      }),
    );
    const editor = (await harness.services.auth.authenticate({ bearer: minted.token }))!;
    const jobPrincipal: Principal = {
      ...editor,
      token: { ...editor.token!, job: { jobId: run.id, runId: run.id, leaseId: 'lease' } },
    };
    await expect(
      harness.services.runNotes.update(jobPrincipal, {
        projectId: fixture.project.id,
        runId: run.id,
        content: 'x',
      }),
    ).rejects.toMatchObject({ status: 403, code: 'job_token_forbidden' });
  });

  it('監査はrun.note.updateに文字数だけを残し、本文を入れない', async () => {
    const run = await fixture.newRun();
    const secretLooking = 'この本文は監査に残らない';
    await entity(await putNote(run.id, secretLooking), 200);
    const page = await entity<AuditEventPage>(
      await request(harness.app, `/api/audit-events?action=run.note.update`, {
        cookie: fixture.administrator.cookie,
      }),
      200,
    );
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      actorUserId: fixture.editor.userId,
      outcome: 'success',
      resourceType: 'run',
      resourceId: run.id,
      projectId: fixture.project.id,
      details: { length: secretLooking.length },
    });
    const stored = await harness.database.query<{ details: string }>(
      "SELECT details::text AS details FROM audit_events WHERE action='run.note.update'",
    );
    expect(stored.rows[0]!.details).not.toContain(secretLooking);
  });
});
