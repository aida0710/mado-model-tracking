import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  Dataset,
  DatasetVersion,
  ModelAutomationRule,
  ModelVersion,
  PluginConnection,
  PromotionEvaluation,
  PromotionEvaluationPage,
  PromotionPolicy,
  Run,
  WorkerJob,
} from '@mmt/contracts';
import type { Connection } from '../src/db/database.js';
import { createHarness, entity, request, testDatabaseUrl, type Harness } from './harness.js';
import { automationRuleInput, containerFixture } from './containerFixtures.js';

// Lets one test make the creator-permission check fail with a database error inside the
// policy's savepoint, the way an unexpected failure during judgement would.
const injectedFailures = vi.hoisted(() => ({ creatorAccess: false }));
vi.mock('../src/repositories/promotionRepository.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/repositories/promotionRepository.js')>();
  return {
    ...actual,
    hasPromotionCreatorAccess: async (
      connection: Connection,
      policy: { projectId: string; createdBy: string },
    ) => {
      if (injectedFailures.creatorAccess) await connection.query('SELECT 1/0');
      return actual.hasPromotionCreatorAccess(connection, policy);
    },
  };
});

// Enough parallel claims for every automatic Job a test starts.
const TEST_TARGET_CONCURRENCY = 20;

async function promotionFixture(harness: Harness) {
  const fixture = await containerFixture(harness);
  const { basePath, administrator, editor, viewer } = fixture;
  await harness.database.query('UPDATE compute_targets SET max_concurrent_jobs=$2 WHERE id=$1', [
    fixture.target.id,
    TEST_TARGET_CONCURRENCY,
  ]);
  const dataset = await entity<Dataset>(
    await request(harness.app, `${basePath}/datasets`, {
      method: 'POST',
      cookie: editor.cookie,
      body: { name: 'Reference set' },
    }),
  );
  const reference = await entity<DatasetVersion>(
    await request(harness.app, `${basePath}/datasets/${dataset.id}/versions`, {
      method: 'POST',
      cookie: editor.cookie,
      body: { version: 'v1', uri: 's3://evaluation/reference', digest: 'digest-reference' },
    }),
  );

  async function registerEvaluationRule(
    name: string,
    overrides: Record<string, unknown> = {},
  ): Promise<ModelAutomationRule> {
    return entity<ModelAutomationRule>(
      await request(harness.app, `${basePath}/automation-rules`, {
        method: 'POST',
        cookie: administrator.cookie,
        body: automationRuleInput(fixture, {
          name,
          kind: 'evaluation',
          inputDatasetVersionIds: [reference.id],
          ...overrides,
        }),
      }),
    );
  }

  async function registerVersion(version: string): Promise<ModelVersion> {
    return entity<ModelVersion>(
      await request(harness.app, `${basePath}/models/${fixture.model.id}/versions`, {
        method: 'POST',
        cookie: editor.cookie,
        body: { version, weightsUri: `https://weights.example.test/${version}.bin` },
      }),
    );
  }

  function policyInput(rule: ModelAutomationRule, overrides: Record<string, unknown> = {}) {
    return {
      name: 'Accuracy gate',
      modelId: fixture.model.id,
      targetAlias: 'production',
      evaluationRuleId: rule.id,
      criteria: [
        { metric: 'accuracy', direction: 'higher', mode: 'absolute', threshold: 0.8 },
        { metric: 'accuracy', direction: 'higher', mode: 'delta', threshold: 0 },
      ],
      ...overrides,
    };
  }

  async function postPolicy(
    body: Record<string, unknown>,
    auth: { cookie?: string; token?: string } = { cookie: administrator.cookie },
  ): Promise<Response> {
    return request(harness.app, `${basePath}/promotion-policies`, { method: 'POST', ...auth, body });
  }

  async function createPolicy(
    rule: ModelAutomationRule,
    options: { overrides?: Record<string, unknown>; cookie?: string } = {},
  ): Promise<PromotionPolicy> {
    return entity<PromotionPolicy>(
      await postPolicy(policyInput(rule, options.overrides), {
        cookie: options.cookie ?? administrator.cookie,
      }),
    );
  }

  async function setProductionAlias(version: ModelVersion): Promise<void> {
    await entity(
      await request(harness.app, `${basePath}/models/${fixture.model.id}/aliases/production`, {
        method: 'PUT',
        cookie: administrator.cookie,
        body: { versionId: version.id },
      }),
      200,
    );
  }

  async function setRole(userId: string, role: 'viewer' | 'editor' | 'admin'): Promise<void> {
    await entity(
      await request(harness.app, `${basePath}/members/${userId}`, {
        method: 'PUT',
        cookie: administrator.cookie,
        body: { role },
      }),
      200,
    );
  }

  async function automaticJob(
    rule: ModelAutomationRule,
    version: ModelVersion,
  ): Promise<{ runId: string; jobId: string }> {
    const execution = await harness.database.query<{ run_id: string; job_id: string }>(
      'SELECT run_id,job_id FROM model_automation_executions WHERE rule_id=$1 AND model_version_id=$2',
      [rule.id, version.id],
    );
    return { runId: execution.rows[0]!.run_id, jobId: execution.rows[0]!.job_id };
  }

  // Claims every queued Job, each under its own worker id, so any of them can be completed.
  const claimed = new Map<string, WorkerJob>();
  let workerSequence = 0;
  async function claimQueuedJobs(): Promise<void> {
    for (;;) {
      workerSequence += 1;
      const response = await entity<{ item: WorkerJob | null }>(
        await request(harness.app, '/api/worker/claim', {
          method: 'POST',
          token: fixture.workerToken,
          body: { workerId: `promotion-worker-${workerSequence}` },
        }),
        200,
      );
      if (!response.item) return;
      claimed.set(response.item.job.id, response.item);
    }
  }

  async function completeJob(
    jobId: string,
    outcome: { status: 'finished' | 'failed'; metrics?: Record<string, number> },
  ): Promise<void> {
    await claimQueuedJobs();
    const job = claimed.get(jobId)!.job;
    const workerPath = `/api/worker/jobs/${jobId}`;
    await entity(
      await request(harness.app, `${workerPath}/heartbeat`, {
        method: 'POST',
        token: fixture.workerToken,
        body: { leaseId: job.leaseId, status: 'running' },
      }),
      200,
    );
    const metrics = Object.entries(outcome.metrics ?? {}).map(([name, value]) => ({
      name,
      value,
      step: 0,
      timestamp: new Date().toISOString(),
    }));
    if (metrics.length) {
      const logged = await request(harness.app, `${workerPath}/metrics`, {
        method: 'POST',
        token: fixture.workerToken,
        body: { leaseId: job.leaseId, metrics },
      });
      expect(logged.status).toBe(204);
    }
    await sendCompletion(jobId, outcome.status);
  }

  // A worker that lost the response sends the same completion again.
  async function sendCompletion(jobId: string, status: 'finished' | 'failed'): Promise<void> {
    await entity(
      await request(harness.app, `/api/worker/jobs/${jobId}/complete`, {
        method: 'POST',
        token: fixture.workerToken,
        body: {
          leaseId: claimed.get(jobId)!.job.leaseId,
          status,
          exitCode: status === 'finished' ? 0 : 1,
        },
      }),
      200,
    );
  }

  async function evaluations(query: Record<string, string> = {}): Promise<PromotionEvaluation[]> {
    const search = new URLSearchParams(query).toString();
    return (
      await entity<PromotionEvaluationPage>(
        await request(harness.app, `${basePath}/promotion-evaluations${search ? `?${search}` : ''}`, {
          cookie: viewer.cookie,
        }),
        200,
      )
    ).items;
  }

  async function auditActions(): Promise<{ action: string; outcome: string }[]> {
    return (
      await harness.database.query<{ action: string; outcome: string }>(
        "SELECT action,outcome FROM audit_events WHERE action LIKE 'promotion.%' ORDER BY occurred_at,id",
      )
    ).rows;
  }

  return {
    ...fixture,
    reference,
    registerEvaluationRule,
    registerVersion,
    policyInput,
    postPolicy,
    createPolicy,
    setProductionAlias,
    setRole,
    automaticJob,
    claimQueuedJobs,
    completeJob,
    sendCompletion,
    evaluations,
    auditActions,
  };
}

type PromotionFixture = Awaited<ReturnType<typeof promotionFixture>>;

describe.skipIf(!testDatabaseUrl)('昇格policyと評価Run終端での自動判定（独立PostgreSQL）', () => {
  let harness: Harness;
  beforeAll(async () => {
    harness = await createHarness();
  });
  beforeEach(async () => {
    injectedFailures.creatorAccess = false;
    await harness.reset();
  });
  afterAll(async () => {
    await harness?.close();
  });

  async function mintToken(fixture: PromotionFixture, scopes: string[]): Promise<string> {
    return (
      await entity<{ token: string }>(
        await request(harness.app, '/api/tokens', {
          method: 'POST',
          cookie: fixture.administrator.cookie,
          body: { name: 'Promotion token', kind: 'personal', projectId: fixture.project.id, scopes },
        }),
      )
    ).token;
  }

  it('自動評価Jobのworker finishedで判定が1件でき、complete再送で増えず、初回は基準未設定で合格扱いになる', async () => {
    const fixture = await promotionFixture(harness);
    const rule = await fixture.registerEvaluationRule('Evaluation A');
    const policy = await fixture.createPolicy(rule);
    expect(policy).toMatchObject({
      baselineAlias: 'production',
      missingBaseline: 'pass',
      autoPromote: false,
      enabled: true,
      createdBy: fixture.administrator.userId,
    });

    const first = await fixture.registerVersion('1');
    const firstJob = await fixture.automaticJob(rule, first);
    await fixture.completeJob(firstJob.jobId, { status: 'finished', metrics: { accuracy: 0.9 } });
    await fixture.sendCompletion(firstJob.jobId, 'finished');

    const firstDecisions = await fixture.evaluations();
    expect(firstDecisions).toEqual([
      expect.objectContaining({
        policyId: policy.id,
        modelId: fixture.model.id,
        candidateVersionId: first.id,
        candidateRunId: firstJob.runId,
        baselineVersionId: null,
        baselineRunId: null,
        decision: 'passed',
        reason: 'baseline_missing_first_promotion',
        promoted: false,
        aliasEventId: null,
        sequence: 1,
        requestedBy: null,
      }),
    ]);
    expect(firstDecisions[0]!.criteriaResults).toEqual([
      expect.objectContaining({ mode: 'absolute', observed: 0.9, outcome: 'passed', reason: null }),
      expect.objectContaining({ mode: 'delta', outcome: 'passed', reason: 'baseline_missing' }),
    ]);

    await fixture.setProductionAlias(first);
    const second = await fixture.registerVersion('2');
    const secondJob = await fixture.automaticJob(rule, second);
    await fixture.completeJob(secondJob.jobId, { status: 'finished', metrics: { accuracy: 0.85 } });
    const [latest] = await fixture.evaluations({ candidateVersionId: second.id });
    expect(latest).toMatchObject({
      candidateRunId: secondJob.runId,
      baselineVersionId: first.id,
      baselineRunId: firstJob.runId,
      decision: 'failed',
      reason: 'criteria_failed',
    });
    expect(latest!.criteriaResults[1]).toMatchObject({
      mode: 'delta',
      candidate: 0.85,
      baseline: 0.9,
      outcome: 'failed',
    });
    expect(await fixture.evaluations({ policyId: policy.id })).toHaveLength(2);
    expect(await fixture.evaluations({ modelId: fixture.model.id, limit: '1' })).toHaveLength(1);
  });

  it('failed・canceledで終わった評価Runは判定しない', async () => {
    const fixture = await promotionFixture(harness);
    const rule = await fixture.registerEvaluationRule('Evaluation A');
    await fixture.createPolicy(rule);
    const failing = await fixture.automaticJob(rule, await fixture.registerVersion('1'));
    await fixture.completeJob(failing.jobId, { status: 'failed', metrics: { accuracy: 0.99 } });
    const canceled = await fixture.automaticJob(rule, await fixture.registerVersion('2'));
    await entity(
      await request(harness.app, `${fixture.basePath}/jobs/${canceled.jobId}/cancel`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
      }),
      200,
    );
    expect(await fixture.evaluations()).toEqual([]);
  });

  it('editorが同じ版・同じ正解セット・同じコード版で手動作成した評価Runをfinishedにしても判定されない', async () => {
    const fixture = await promotionFixture(harness);
    const rule = await fixture.registerEvaluationRule('Evaluation A');
    await fixture.createPolicy(rule);
    const version = await fixture.registerVersion('1');
    // automation.* tags are reserved, so the Run looks like an automatic one in everything else.
    const manual = await entity<Run>(
      await request(harness.app, `${fixture.basePath}/runs`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: {
          experimentId: fixture.experiment.id,
          name: 'Hand-made evaluation',
          kind: 'evaluation',
          modelVersionId: version.id,
          codeVersionId: rule.codeVersionId,
          inputDatasetVersionIds: rule.inputDatasetVersionIds,
        },
      }),
    );
    for (const status of ['running', 'finished'])
      await entity(
        await request(harness.app, `${fixture.basePath}/runs/${manual.id}`, {
          method: 'PATCH',
          cookie: fixture.editor.cookie,
          body: { status },
        }),
        200,
      );
    expect(await fixture.evaluations()).toEqual([]);
  });

  it('別の評価ruleが作ったRunは対象外で、policyのruleのRunだけを判定する', async () => {
    const fixture = await promotionFixture(harness);
    const ruleA = await fixture.registerEvaluationRule('Evaluation A');
    const ruleB = await fixture.registerEvaluationRule('Evaluation B');
    await fixture.createPolicy(ruleA);
    const version = await fixture.registerVersion('1');
    const jobB = await fixture.automaticJob(ruleB, version);
    await fixture.completeJob(jobB.jobId, { status: 'finished', metrics: { accuracy: 0.95 } });
    expect(await fixture.evaluations()).toEqual([]);
    const jobA = await fixture.automaticJob(ruleA, version);
    await fixture.completeJob(jobA.jobId, { status: 'finished', metrics: { accuracy: 0.95 } });
    expect(await fixture.evaluations()).toEqual([
      expect.objectContaining({ candidateRunId: jobA.runId, decision: 'passed' }),
    ]);
  });

  it('基準版も同じruleの自動実行Runだけを使い、別ruleや手動の評価Runしか無ければinsufficientになる', async () => {
    const fixture = await promotionFixture(harness);
    const ruleB = await fixture.registerEvaluationRule('Evaluation B');
    const baseline = await fixture.registerVersion('1');
    const baselineJobB = await fixture.automaticJob(ruleB, baseline);
    await fixture.completeJob(baselineJobB.jobId, { status: 'finished', metrics: { accuracy: 0.5 } });
    const manual = await entity<Run>(
      await request(harness.app, `${fixture.basePath}/runs`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: {
          experimentId: fixture.experiment.id,
          name: 'Hand-made baseline evaluation',
          kind: 'evaluation',
          modelVersionId: baseline.id,
          codeVersionId: ruleB.codeVersionId,
          inputDatasetVersionIds: ruleB.inputDatasetVersionIds,
        },
      }),
    );
    for (const status of ['running', 'finished'])
      await entity(
        await request(harness.app, `${fixture.basePath}/runs/${manual.id}`, {
          method: 'PATCH',
          cookie: fixture.editor.cookie,
          body: { status },
        }),
        200,
      );
    await fixture.setProductionAlias(baseline);

    const ruleA = await fixture.registerEvaluationRule('Evaluation A');
    await fixture.createPolicy(ruleA);
    const candidate = await fixture.registerVersion('2');
    const candidateJob = await fixture.automaticJob(ruleA, candidate);
    await fixture.completeJob(candidateJob.jobId, { status: 'finished', metrics: { accuracy: 0.9 } });
    expect(await fixture.evaluations()).toEqual([
      expect.objectContaining({
        candidateRunId: candidateJob.runId,
        baselineVersionId: baseline.id,
        baselineRunId: null,
        decision: 'insufficient',
        reason: 'baseline_not_evaluated',
      }),
    ]);
  });

  it('手動retryで成功した評価Runも判定し、その版が基準になったときもretryのRunを基準に使う', async () => {
    const fixture = await promotionFixture(harness);
    const rule = await fixture.registerEvaluationRule('Evaluation A');
    await fixture.createPolicy(rule);
    const first = await fixture.registerVersion('1');
    const original = await fixture.automaticJob(rule, first);
    await fixture.completeJob(original.jobId, { status: 'failed' });
    const retry = await entity<{ run: Run; job: { id: string } }>(
      await request(harness.app, `${fixture.basePath}/jobs/${original.jobId}/retry`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
      }),
    );
    await fixture.completeJob(retry.job.id, { status: 'finished', metrics: { accuracy: 0.9 } });
    expect(await fixture.evaluations()).toEqual([
      expect.objectContaining({ candidateRunId: retry.run.id, decision: 'passed' }),
    ]);

    await fixture.setProductionAlias(first);
    const second = await fixture.registerVersion('2');
    const secondJob = await fixture.automaticJob(rule, second);
    await fixture.completeJob(secondJob.jobId, { status: 'finished', metrics: { accuracy: 0.95 } });
    const [latest] = await fixture.evaluations({ candidateVersionId: second.id });
    expect(latest).toMatchObject({ baselineRunId: retry.run.id, decision: 'passed', reason: null });
    const comparison = await entity<{ baselineRunId: string | null }>(
      await request(
        harness.app,
        `${fixture.basePath}/models/${fixture.model.id}/versions/${second.id}/evaluation-comparison?evaluationRuleId=${rule.id}`,
        { cookie: fixture.viewer.cookie },
      ),
      200,
    );
    expect(comparison.baselineRunId).toBe(retry.run.id);
  });

  it('無効にしたpolicyは判定せず、有効/無効の切替は監査に残る', async () => {
    const fixture = await promotionFixture(harness);
    const rule = await fixture.registerEvaluationRule('Evaluation A');
    const policy = await fixture.createPolicy(rule);
    const disabled = await entity<PromotionPolicy>(
      await request(harness.app, `${fixture.basePath}/promotion-policies/${policy.id}`, {
        method: 'PATCH',
        cookie: fixture.administrator.cookie,
        body: { enabled: false },
      }),
      200,
    );
    expect(disabled.enabled).toBe(false);
    const job = await fixture.automaticJob(rule, await fixture.registerVersion('1'));
    await fixture.completeJob(job.jobId, { status: 'finished', metrics: { accuracy: 0.9 } });
    expect(await fixture.evaluations()).toEqual([]);
    expect(await fixture.auditActions()).toEqual([
      { action: 'promotion.policy.create', outcome: 'success' },
      { action: 'promotion.policy.update', outcome: 'success' },
    ]);
  });

  it('policy作成者がProject adminでなくなっていればskipped(creator_access_revoked)を記録する', async () => {
    const fixture = await promotionFixture(harness);
    const rule = await fixture.registerEvaluationRule('Evaluation A');
    await fixture.setRole(fixture.editor.userId, 'admin');
    const policy = await fixture.createPolicy(rule, { cookie: fixture.editor.cookie });
    expect(policy.createdBy).toBe(fixture.editor.userId);
    await fixture.setRole(fixture.editor.userId, 'editor');
    const job = await fixture.automaticJob(rule, await fixture.registerVersion('1'));
    await fixture.completeJob(job.jobId, { status: 'finished', metrics: { accuracy: 0.9 } });
    expect(await fixture.evaluations()).toEqual([
      expect.objectContaining({
        candidateRunId: job.runId,
        decision: 'skipped',
        reason: 'creator_access_revoked',
        criteriaResults: [],
      }),
    ]);
  });

  it('判定中のエラーはskipped(evaluation_error)として残り、記録自体が失敗してもRun終端とoutboxは確定する', async () => {
    const fixture = await promotionFixture(harness);
    await entity<PluginConnection>(
      await request(harness.app, `${fixture.basePath}/plugins`, {
        method: 'POST',
        cookie: fixture.administrator.cookie,
        body: { name: 'Lineage', baseUrl: 'http://127.0.0.1:4999', tokenEnv: 'MMT_TEST_PLUGIN_TOKEN' },
      }),
    );
    const rule = await fixture.registerEvaluationRule('Evaluation A');
    await fixture.createPolicy(rule);
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      injectedFailures.creatorAccess = true;
      const judged = await fixture.automaticJob(rule, await fixture.registerVersion('1'));
      await fixture.completeJob(judged.jobId, { status: 'finished', metrics: { accuracy: 0.9 } });
      injectedFailures.creatorAccess = false;
      expect(await fixture.evaluations()).toEqual([
        expect.objectContaining({ candidateRunId: judged.runId, decision: 'skipped', reason: 'evaluation_error' }),
      ]);

      await harness.database.query(`CREATE FUNCTION reject_promotion_evaluation_for_test() RETURNS trigger
        LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected promotion failure'; END; $$`);
      await harness.database.query(`CREATE TRIGGER promotion_evaluation_failure_for_test
        BEFORE INSERT ON model_promotion_evaluations
        FOR EACH ROW EXECUTE FUNCTION reject_promotion_evaluation_for_test()`);
      try {
        const unrecorded = await fixture.automaticJob(rule, await fixture.registerVersion('2'));
        await fixture.completeJob(unrecorded.jobId, { status: 'finished', metrics: { accuracy: 0.9 } });
        const state = await harness.database.query<{ run_status: string; job_status: string }>(
          `SELECT r.status AS run_status,j.status AS job_status FROM runs r JOIN jobs j ON j.run_id=r.id
          WHERE r.id=$1`,
          [unrecorded.runId],
        );
        expect(state.rows).toEqual([{ run_status: 'finished', job_status: 'finished' }]);
        const outbox = await harness.database.query<{ type: string }>(
          "SELECT event->>'type' AS type FROM plugin_outbox WHERE event->'run'->>'id'=$1 ORDER BY created_at",
          [unrecorded.runId],
        );
        expect(outbox.rows.map((row) => row.type)).toContain('run.finished');
        expect(await fixture.evaluations()).toHaveLength(1);
      } finally {
        await harness.database.query(
          'DROP TRIGGER promotion_evaluation_failure_for_test ON model_promotion_evaluations',
        );
        await harness.database.query('DROP FUNCTION reject_promotion_evaluation_for_test()');
      }
    } finally {
      logged.mockRestore();
    }
  });

  it('policyの設定はDBのtriggerで変更を拒否し、判定行はUPDATE・DELETEできない', async () => {
    const fixture = await promotionFixture(harness);
    const rule = await fixture.registerEvaluationRule('Evaluation A');
    const policy = await fixture.createPolicy(rule);
    await expect(
      harness.database.query(
        `UPDATE model_promotion_policies SET criteria='[{"metric":"accuracy","direction":"higher","mode":"absolute","threshold":0}]' WHERE id=$1`,
        [policy.id],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      harness.database.query("UPDATE model_promotion_policies SET target_alias='staging' WHERE id=$1", [
        policy.id,
      ]),
    ).rejects.toMatchObject({ code: '23514' });
    await harness.database.query('UPDATE model_promotion_policies SET enabled=false WHERE id=$1', [
      policy.id,
    ]);
    await harness.database.query('UPDATE model_promotion_policies SET enabled=true WHERE id=$1', [
      policy.id,
    ]);

    const job = await fixture.automaticJob(rule, await fixture.registerVersion('1'));
    await fixture.completeJob(job.jobId, { status: 'finished', metrics: { accuracy: 0.9 } });
    const [decision] = await fixture.evaluations();
    await expect(
      harness.database.query("UPDATE model_promotion_evaluations SET decision='failed' WHERE id=$1", [
        decision!.id,
      ]),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      harness.database.query('DELETE FROM model_promotion_evaluations WHERE id=$1', [decision!.id]),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('policyの作成はProject adminとadmin scopeのtokenだけで、editorの拒否は監査に残り、viewerは読める', async () => {
    const fixture = await promotionFixture(harness);
    const rule = await fixture.registerEvaluationRule('Evaluation A');
    const body = fixture.policyInput(rule);
    expect((await fixture.postPolicy(body, { cookie: fixture.editor.cookie })).status).toBe(403);
    expect((await fixture.postPolicy(body, { cookie: fixture.viewer.cookie })).status).toBe(403);
    expect((await fixture.postPolicy(body, { cookie: fixture.outsider.cookie })).status).toBe(403);
    const withoutAdminScope = await mintToken(fixture, ['read', 'registry:write', 'jobs:write']);
    expect((await fixture.postPolicy(body, { token: withoutAdminScope })).status).toBe(403);
    const adminToken = await mintToken(fixture, ['admin']);
    const created = await entity<PromotionPolicy>(await fixture.postPolicy(body, { token: adminToken }));

    const list = await entity<{ items: PromotionPolicy[] }>(
      await request(
        harness.app,
        `${fixture.basePath}/promotion-policies?modelId=${fixture.model.id}`,
        { cookie: fixture.viewer.cookie },
      ),
      200,
    );
    expect(list.items.map((item) => item.id)).toEqual([created.id]);
    expect(
      (
        await request(harness.app, `${fixture.basePath}/promotion-policies/${created.id}`, {
          method: 'PATCH',
          cookie: fixture.editor.cookie,
          body: { enabled: false },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(harness.app, `${fixture.basePath}/promotion-evaluations`, {
          cookie: fixture.outsider.cookie,
        })
      ).status,
    ).toBe(403);
    expect(await fixture.auditActions()).toEqual([
      { action: 'promotion.policy.create', outcome: 'denied' },
      { action: 'promotion.policy.create', outcome: 'denied' },
      { action: 'promotion.policy.create', outcome: 'denied' },
      { action: 'promotion.policy.create', outcome: 'denied' },
      { action: 'promotion.policy.create', outcome: 'success' },
      { action: 'promotion.policy.update', outcome: 'denied' },
    ]);
  });

  it('評価ruleはkind=evaluationでModelの系列を対象にする同じProjectのruleでなければ作成できない', async () => {
    const fixture = await promotionFixture(harness);
    const inference = await fixture.registerEvaluationRule('Inference', { kind: 'inference' });
    const response = await fixture.postPolicy(fixture.policyInput(inference));
    expect(response.status).toBe(422);
    expect(((await response.json()) as { code: string }).code).toBe('promotion_rule_not_evaluation');
    const otherFamilyCode = await entity<{ id: string }>(
      await request(harness.app, `${fixture.basePath}/codes/${fixture.code.id}/versions`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: {
          version: 'llama-evaluation',
          source: null,
          runtime: { kind: 'docker', image: `registry.example.test/mmt/eval@sha256:${'b'.repeat(64)}` },
          entrypoint: ['python', '/app/evaluate.py'],
          supportedModelFamilies: ['llama'],
          taskTypes: ['evaluation'],
        },
      }),
    );
    const otherFamily = await fixture.registerEvaluationRule('Llama evaluation', {
      modelFamilies: ['llama'],
      codeVersionId: otherFamilyCode.id,
    });
    const mismatch = await fixture.postPolicy(fixture.policyInput(otherFamily));
    expect(mismatch.status).toBe(422);
    expect(((await mismatch.json()) as { code: string }).code).toBe('promotion_rule_family_mismatch');
    const evaluation = await fixture.registerEvaluationRule('Evaluation A');
    for (const criteria of [
      [],
      [{ metric: 'accuracy', direction: 'higher', mode: 'absolute', threshold: Number.NaN }],
      [
        { metric: 'accuracy', direction: 'higher', mode: 'absolute', threshold: 0.8 },
        { metric: 'accuracy', direction: 'higher', mode: 'absolute', threshold: 0.9 },
      ],
    ])
      expect((await fixture.postPolicy(fixture.policyInput(evaluation, { criteria }))).status).toBe(422);
    expect(
      (await fixture.postPolicy(fixture.policyInput(evaluation, { evaluationRuleId: crypto.randomUUID() })))
        .status,
    ).toBe(404);
  });

  it('再判定はeditorには403、Project adminなら同じ候補Runの新しい行(sequence 2)を追加する', async () => {
    const fixture = await promotionFixture(harness);
    const rule = await fixture.registerEvaluationRule('Evaluation A');
    await fixture.createPolicy(rule);
    const first = await fixture.registerVersion('1');
    const job = await fixture.automaticJob(rule, first);
    await fixture.completeJob(job.jobId, { status: 'finished', metrics: { accuracy: 0.9 } });
    const [original] = await fixture.evaluations();
    const endpoint = `${fixture.basePath}/promotion-evaluations/${original!.id}/reevaluate`;
    expect((await request(harness.app, endpoint, { method: 'POST', cookie: fixture.editor.cookie })).status).toBe(403);
    const withoutAdminScope = await mintToken(fixture, ['read', 'registry:write']);
    expect((await request(harness.app, endpoint, { method: 'POST', token: withoutAdminScope })).status).toBe(403);

    // The baseline alias now points at the candidate itself, so the delta is 0 and still passes.
    await fixture.setProductionAlias(first);
    const again = await entity<PromotionEvaluation>(
      await request(harness.app, endpoint, { method: 'POST', cookie: fixture.administrator.cookie }),
    );
    expect(again).toMatchObject({
      candidateRunId: original!.candidateRunId,
      sequence: 2,
      requestedBy: fixture.administrator.userId,
      baselineVersionId: first.id,
      baselineRunId: job.runId,
      decision: 'passed',
      reason: null,
    });
    const third = await entity<PromotionEvaluation>(
      await request(harness.app, endpoint, { method: 'POST', cookie: fixture.administrator.cookie }),
    );
    expect(third.sequence).toBe(3);
    expect((await fixture.evaluations()).map((item) => item.sequence)).toEqual([3, 2, 1]);
    const page = await entity<PromotionEvaluationPage>(
      await request(harness.app, `${fixture.basePath}/promotion-evaluations?limit=2`, {
        cookie: fixture.viewer.cookie,
      }),
      200,
    );
    expect(page.nextCursor).toBe(page.items[1]!.id);
    const next = await entity<PromotionEvaluationPage>(
      await request(
        harness.app,
        `${fixture.basePath}/promotion-evaluations?limit=2&cursor=${page.nextCursor}`,
        { cookie: fixture.viewer.cookie },
      ),
      200,
    );
    expect(next).toEqual({ items: [expect.objectContaining({ sequence: 1 })], nextCursor: null });
    expect((await fixture.auditActions()).filter((item) => item.action.endsWith('reevaluate'))).toEqual([
      { action: 'promotion.evaluation.reevaluate', outcome: 'denied' },
      { action: 'promotion.evaluation.reevaluate', outcome: 'denied' },
      { action: 'promotion.evaluation.reevaluate', outcome: 'success' },
      { action: 'promotion.evaluation.reevaluate', outcome: 'success' },
    ]);
  });
});
