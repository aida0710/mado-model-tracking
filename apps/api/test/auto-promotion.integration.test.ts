import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type {
  Model,
  ModelAliasEvent,
  ModelAliasEventPage,
  ModelAliasProtection,
  ModelAutomationRule,
  ModelVersion,
  Project,
  PromotionEvaluation,
  PromotionPolicy,
  ServiceAccount,
} from '@mmt/contracts';
import { transaction } from '../src/db/database.js';
import { assignModelAlias } from '../src/repositories/modelAliasRepository.js';
import { createHarness, entity, request, testDatabaseUrl, type Harness } from './harness.js';
import { promotionFixture, type PromotionFixture } from './promotionFixtures.js';

// How long the concurrency test waits for the judgement to block on the Model lock.
const LOCK_WAIT_DEADLINE_MILLISECONDS = 10_000;

describe.skipIf(!testDatabaseUrl)('合格時のalias自動切替と保護alias（独立PostgreSQL）', () => {
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

  async function errorCode(response: Response): Promise<string> {
    return ((await response.json()) as { code: string }).code;
  }

  async function aliasEvents(fixture: PromotionFixture): Promise<ModelAliasEvent[]> {
    return (
      await entity<ModelAliasEventPage>(
        await request(harness.app, `${fixture.basePath}/models/${fixture.model.id}/alias-events`, {
          cookie: fixture.viewer.cookie,
        }),
        200,
      )
    ).items;
  }

  // Alias name -> version label ("1", "2", ...) of the fixture's Model.
  async function currentAliases(fixture: PromotionFixture): Promise<Record<string, string>> {
    const read = async <T>(path: string) =>
      (
        await entity<{ items: T[] }>(
          await request(harness.app, `${fixture.basePath}${path}`, {
            cookie: fixture.viewer.cookie,
          }),
          200,
        )
      ).items;
    const model = (await read<Model>('/models')).find((item) => item.id === fixture.model.id)!;
    const versions = await read<ModelVersion>(`/models/${fixture.model.id}/versions`);
    return Object.fromEntries(
      Object.entries(model.aliases).map(([alias, versionId]) => [
        alias,
        versions.find((version) => version.id === versionId)!.version,
      ]),
    );
  }

  function putAlias(
    fixture: PromotionFixture,
    change: { alias?: string; cookie: string; body: Record<string, unknown> },
  ): Promise<Response> {
    return request(
      harness.app,
      `${fixture.basePath}/models/${fixture.model.id}/aliases/${change.alias ?? 'production'}`,
      { method: 'PUT', cookie: change.cookie, body: change.body },
    );
  }

  function putProtection(
    fixture: PromotionFixture,
    protection: {
      alias?: string;
      modelId?: string;
      cookie?: string;
      body: Record<string, unknown>;
    },
  ): Promise<Response> {
    const query = protection.modelId ? `?modelId=${protection.modelId}` : '';
    return request(
      harness.app,
      `${fixture.basePath}/alias-protections/${protection.alias ?? 'production'}${query}`,
      {
        method: 'PUT',
        cookie: protection.cookie ?? fixture.administrator.cookie,
        body: protection.body,
      },
    );
  }

  // Registers a version whose automatic evaluation Job finishes with the given accuracy.
  async function evaluatedVersion(
    fixture: PromotionFixture,
    evaluation: { rule: ModelAutomationRule; version: string; accuracy: number },
  ): Promise<{ version: ModelVersion; decision: PromotionEvaluation | undefined }> {
    const version = await fixture.registerVersion(evaluation.version);
    const job = await fixture.automaticJob(evaluation.rule, version);
    await fixture.completeJob(job.jobId, {
      status: 'finished',
      metrics: { accuracy: evaluation.accuracy },
    });
    const [decision] = await fixture.evaluations({ candidateVersionId: version.id });
    return { version, decision };
  }

  async function serviceAccount(
    fixture: { basePath: string; administrator: { cookie: string } },
    account: { name: string; role: 'viewer' | 'editor' | 'admin' },
  ): Promise<ServiceAccount> {
    return entity<ServiceAccount>(
      await request(harness.app, `${fixture.basePath}/service-accounts`, {
        method: 'POST',
        cookie: fixture.administrator.cookie,
        body: { ...account, description: '' },
      }),
    );
  }

  function transferOwner(
    fixture: PromotionFixture,
    transfer: { policyId: string; serviceAccountId: string; cookie?: string },
  ): Promise<Response> {
    return request(
      harness.app,
      `${fixture.basePath}/promotion-policies/${transfer.policyId}/owner`,
      {
        method: 'PUT',
        cookie: transfer.cookie ?? fixture.administrator.cookie,
        body: { serviceAccountId: transfer.serviceAccountId },
      },
    );
  }

  it('autoPromoteのpolicyで合格すると対象aliasが切り替わり、alias eventにsource=promotion_policyと判定IDが残る', async () => {
    const fixture = await promotionFixture(harness);
    const rule = await fixture.registerEvaluationRule('Evaluation A');
    const policy = await fixture.createPolicy(rule, { overrides: { autoPromote: true } });
    expect(policy.runAsUserId).toBe(fixture.administrator.userId);

    const first = await evaluatedVersion(fixture, { rule, version: '1', accuracy: 0.9 });
    expect(first.decision).toMatchObject({
      decision: 'passed',
      reason: 'baseline_missing_first_promotion',
      promoted: true,
    });
    expect((await currentAliases(fixture)).production).toBe('1');
    const [event] = await aliasEvents(fixture);
    expect(event).toMatchObject({
      id: first.decision!.aliasEventId,
      alias: 'production',
      previousVersionId: null,
      versionId: first.version.id,
      source: 'promotion_policy',
      promotionEvaluationId: first.decision!.id,
      actor: { userId: fixture.administrator.userId, tokenId: null },
    });
    expect(event!.reason).toContain('Accuracy gate');
    expect(event!.reason).toContain('accuracy=0.9 ≥ 0.8');

    const second = await evaluatedVersion(fixture, { rule, version: '2', accuracy: 0.95 });
    expect(second.decision).toMatchObject({
      decision: 'passed',
      baselineVersionId: first.version.id,
      reason: null,
      promoted: true,
    });
    expect((await currentAliases(fixture)).production).toBe('2');
    expect((await aliasEvents(fixture))[0]).toMatchObject({
      previousVersionId: first.version.id,
      versionId: second.version.id,
      promotionEvaluationId: second.decision!.id,
    });
  });

  it('不合格とinsufficientではaliasが動かず、autoPromoteが無いpolicyの合格でも動かない', async () => {
    const fixture = await promotionFixture(harness);
    const rule = await fixture.registerEvaluationRule('Evaluation A');
    await fixture.createPolicy(rule, { overrides: { autoPromote: true } });
    await evaluatedVersion(fixture, { rule, version: '1', accuracy: 0.9 });

    const failing = await evaluatedVersion(fixture, { rule, version: '2', accuracy: 0.85 });
    expect(failing.decision).toMatchObject({
      decision: 'failed',
      promoted: false,
      aliasEventId: null,
    });
    expect((await currentAliases(fixture)).production).toBe('1');

    // The fixture's first version was never evaluated by the rule, so the deltas cannot be judged.
    await entity(
      await putAlias(fixture, {
        cookie: fixture.administrator.cookie,
        body: { versionId: fixture.modelVersion.id },
      }),
      200,
    );
    const insufficient = await evaluatedVersion(fixture, { rule, version: '3', accuracy: 0.99 });
    expect(insufficient.decision).toMatchObject({ decision: 'insufficient', promoted: false });
    expect((await currentAliases(fixture)).production).toBe(fixture.modelVersion.version);

    const manualOnly = await fixture.registerEvaluationRule('Evaluation B');
    await fixture.createPolicy(manualOnly, {
      overrides: { name: 'Manual gate', targetAlias: 'staging', baselineAlias: 'staging' },
    });
    const passedWithoutPromotion = await fixture.registerVersion('4');
    const job = await fixture.automaticJob(manualOnly, passedWithoutPromotion);
    await fixture.completeJob(job.jobId, { status: 'finished', metrics: { accuracy: 0.9 } });
    const [decision] = await fixture.evaluations({ candidateVersionId: passedWithoutPromotion.id });
    expect(decision).toMatchObject({ decision: 'passed', promoted: false });
    expect((await currentAliases(fixture)).staging).toBeUndefined();
  });

  it('判定と同時に手動で基準aliasを変えると、手動の変更を上書きせずbaseline_changedを記録する', async () => {
    const fixture = await promotionFixture(harness);
    const rule = await fixture.registerEvaluationRule('Evaluation A');
    await fixture.createPolicy(rule, { overrides: { autoPromote: true } });
    const baseline = await evaluatedVersion(fixture, { rule, version: '1', accuracy: 0.8 });
    expect((await currentAliases(fixture)).production).toBe('1');
    const manualChoice = await fixture.registerVersion('2');
    const candidate = await fixture.registerVersion('3');
    const candidateJob = await fixture.automaticJob(rule, candidate);

    let releaseManual!: () => void;
    const manualMayCommit = new Promise<void>((resolve) => (releaseManual = resolve));
    let manualAssigned!: () => void;
    const manualHoldsLock = new Promise<void>((resolve) => (manualAssigned = resolve));
    const manualTransaction = transaction(harness.database, async (connection) => {
      await assignModelAlias(connection, {
        modelId: fixture.model.id,
        alias: 'production',
        versionId: manualChoice.id,
        actor: { userId: fixture.administrator.userId, tokenId: null },
        source: 'api',
        reason: 'manual rollout',
        guard: async () => undefined,
      });
      manualAssigned();
      await manualMayCommit;
    });
    await manualHoldsLock;
    // The judgement reads the committed baseline (version 1), then waits for the Model lock.
    const completion = fixture.completeJob(candidateJob.jobId, {
      status: 'finished',
      metrics: { accuracy: 0.9 },
    });
    const deadline = Date.now() + LOCK_WAIT_DEADLINE_MILLISECONDS;
    while (
      !(
        await harness.database.query(
          `SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock'
          AND query LIKE 'SELECT project_id FROM models WHERE id=$1 FOR UPDATE%'`,
        )
      ).rowCount
    ) {
      if (Date.now() > deadline) throw new Error('The judgement never waited for the Model lock');
      await new Promise((resolve) => setImmediate(resolve));
    }
    releaseManual();
    await Promise.all([manualTransaction, completion]);

    const [decision] = await fixture.evaluations({ candidateVersionId: candidate.id });
    expect(decision).toMatchObject({
      decision: 'passed',
      baselineVersionId: baseline.version.id,
      reason: 'baseline_changed',
      promoted: false,
      aliasEventId: null,
    });
    expect((await currentAliases(fixture)).production).toBe('2');
    expect((await aliasEvents(fixture))[0]).toMatchObject({
      source: 'api',
      versionId: manualChoice.id,
    });
  });

  it('保護aliasはrequiredRole未満の変更を403にし、admin専用でも理由か合格判定が要る', async () => {
    const fixture = await promotionFixture(harness);
    const version = await fixture.registerVersion('1');
    await fixture.setProductionAlias(fixture.modelVersion);
    expect(
      await errorCode(
        await putProtection(fixture, {
          cookie: fixture.editor.cookie,
          body: { requiredRole: 'editor' },
        }),
      ),
    ).toBe('project_forbidden');
    const protection = await entity<ModelAliasProtection>(
      await putProtection(fixture, { body: { requiredRole: 'admin' } }),
      200,
    );
    expect(protection).toMatchObject({
      modelId: null,
      alias: 'production',
      requiredRole: 'admin',
      requirePassedEvaluation: false,
      createdBy: fixture.administrator.userId,
    });

    const byEditor = await putAlias(fixture, {
      cookie: fixture.editor.cookie,
      body: { versionId: version.id, reason: 'hotfix' },
    });
    expect(byEditor.status).toBe(403);
    expect(await errorCode(byEditor)).toBe('alias_protected');
    const removalByEditor = await request(
      harness.app,
      `${fixture.basePath}/models/${fixture.model.id}/aliases/production`,
      { method: 'DELETE', cookie: fixture.editor.cookie },
    );
    expect(removalByEditor.status).toBe(403);
    const withoutReason = await putAlias(fixture, {
      cookie: fixture.administrator.cookie,
      body: { versionId: version.id },
    });
    expect(withoutReason.status).toBe(422);
    expect(await errorCode(withoutReason)).toBe('alias_reason_required');
    await entity(
      await putAlias(fixture, {
        cookie: fixture.administrator.cookie,
        body: { versionId: version.id, reason: 'hotfix' },
      }),
      200,
    );
    expect((await currentAliases(fixture)).production).toBe('1');
    // Other aliases stay unprotected.
    await entity(
      await putAlias(fixture, {
        alias: 'staging',
        cookie: fixture.editor.cookie,
        body: { versionId: version.id },
      }),
      200,
    );

    // A Model-level row can only tighten the Project-wide one.
    await entity(
      await putProtection(fixture, {
        modelId: fixture.model.id,
        body: { requiredRole: 'editor', requirePassedEvaluation: true },
      }),
      200,
    );
    const listed = await entity<{ items: ModelAliasProtection[] }>(
      await request(
        harness.app,
        `${fixture.basePath}/alias-protections?modelId=${fixture.model.id}`,
        { cookie: fixture.viewer.cookie },
      ),
      200,
    );
    expect(listed.items.map((item) => [item.modelId, item.requiredRole])).toEqual([
      [null, 'admin'],
      [fixture.model.id, 'editor'],
    ]);
    const stillAdminOnly = await putAlias(fixture, {
      cookie: fixture.editor.cookie,
      body: { versionId: fixture.modelVersion.id, reason: 'rollback' },
    });
    expect(await errorCode(stillAdminOnly)).toBe('alias_protected');
    const adminNeedsEvaluation = await putAlias(fixture, {
      cookie: fixture.administrator.cookie,
      body: { versionId: fixture.modelVersion.id, reason: 'rollback' },
    });
    expect(await errorCode(adminNeedsEvaluation)).toBe('alias_evaluation_required');

    const removed = await request(harness.app, `${fixture.basePath}/alias-protections/production`, {
      method: 'DELETE',
      cookie: fixture.administrator.cookie,
    });
    expect(removed.status).toBe(204);
    const audit = await harness.database.query<{ action: string; outcome: string }>(
      "SELECT action,outcome FROM audit_events WHERE action LIKE 'model_alias.protection.%' ORDER BY occurred_at,id",
    );
    expect(audit.rows).toEqual([
      { action: 'model_alias.protection.set', outcome: 'denied' },
      { action: 'model_alias.protection.set', outcome: 'success' },
      { action: 'model_alias.protection.set', outcome: 'success' },
      { action: 'model_alias.protection.delete', outcome: 'success' },
    ]);
  });

  it('合格判定が必要な保護aliasは、同じバージョンの合格判定でだけeditorが変えられる', async () => {
    const fixture = await promotionFixture(harness);
    const rule = await fixture.registerEvaluationRule('Evaluation A');
    await fixture.createPolicy(rule);
    const baseline = await evaluatedVersion(fixture, { rule, version: '1', accuracy: 0.9 });
    await fixture.setProductionAlias(baseline.version);
    const failing = await evaluatedVersion(fixture, { rule, version: '2', accuracy: 0.85 });
    const passing = await evaluatedVersion(fixture, { rule, version: '3', accuracy: 0.95 });
    expect([failing.decision?.decision, passing.decision?.decision]).toEqual(['failed', 'passed']);
    await entity(
      await putProtection(fixture, {
        body: { requiredRole: 'editor', requirePassedEvaluation: true },
      }),
      200,
    );

    const cases: [Record<string, unknown>, number, string][] = [
      [{ versionId: passing.version.id, reason: 'looks good' }, 422, 'alias_evaluation_required'],
      [
        { versionId: failing.version.id, evaluationId: passing.decision!.id },
        422,
        'alias_evaluation_mismatch',
      ],
      [
        { versionId: failing.version.id, evaluationId: failing.decision!.id },
        409,
        'alias_evaluation_not_passed',
      ],
    ];
    for (const [body, status, code] of cases) {
      const response = await putAlias(fixture, { cookie: fixture.editor.cookie, body });
      expect(response.status).toBe(status);
      expect(await errorCode(response)).toBe(code);
    }
    // A decision for another alias does not justify this one.
    const staging = await putAlias(fixture, {
      alias: 'staging',
      cookie: fixture.editor.cookie,
      body: { versionId: passing.version.id, evaluationId: passing.decision!.id },
    });
    expect(await errorCode(staging)).toBe('alias_evaluation_mismatch');

    // The Python SDK sends the same evidence as promotionEvaluationId.
    await entity(
      await putAlias(fixture, {
        cookie: fixture.editor.cookie,
        body: { versionId: passing.version.id, promotionEvaluationId: passing.decision!.id },
      }),
      200,
    );
    expect((await aliasEvents(fixture))[0]).toMatchObject({
      source: 'web',
      versionId: passing.version.id,
      promotionEvaluationId: passing.decision!.id,
      actor: { userId: fixture.editor.userId },
    });
    // No decision justifies a removal, so it takes Project admin.
    const removal = await request(
      harness.app,
      `${fixture.basePath}/models/${fixture.model.id}/aliases/production`,
      { method: 'DELETE', cookie: fixture.editor.cookie },
    );
    expect(await errorCode(removal)).toBe('alias_protected');
  });

  it('保護aliasでも自動昇格は続き、policyの実行ユーザーが権限を失うと自動昇格されない', async () => {
    const fixture = await promotionFixture(harness);
    await fixture.setRole(fixture.editor.userId, 'admin');
    const rule = await fixture.registerEvaluationRule('Evaluation A');
    const policy = await fixture.createPolicy(rule, {
      overrides: { autoPromote: true },
      cookie: fixture.editor.cookie,
    });
    expect(policy.runAsUserId).toBe(fixture.editor.userId);
    await entity(
      await putProtection(fixture, {
        body: { requiredRole: 'admin', requirePassedEvaluation: true },
      }),
      200,
    );
    await evaluatedVersion(fixture, { rule, version: '1', accuracy: 0.9 });
    expect((await currentAliases(fixture)).production).toBe('1');

    await fixture.setRole(fixture.editor.userId, 'editor');
    const revoked = await evaluatedVersion(fixture, { rule, version: '2', accuracy: 0.95 });
    expect(revoked.decision).toMatchObject({
      decision: 'skipped',
      reason: 'creator_access_revoked',
      promoted: false,
    });
    expect((await currentAliases(fixture)).production).toBe('1');
  });

  it('所有者をService Accountへ移すと、元の作成者を外しても自動昇格が続く', async () => {
    const fixture = await promotionFixture(harness);
    await fixture.setRole(fixture.editor.userId, 'admin');
    const rule = await fixture.registerEvaluationRule('Evaluation A');
    const policy = await fixture.createPolicy(rule, {
      overrides: { autoPromote: true },
      cookie: fixture.editor.cookie,
    });
    const releaseBot = await serviceAccount(fixture, { name: 'release-bot', role: 'admin' });

    const transferred = await entity<PromotionPolicy>(
      await transferOwner(fixture, { policyId: policy.id, serviceAccountId: releaseBot.id }),
      200,
    );
    expect(transferred).toMatchObject({
      runAsUserId: releaseBot.id,
      createdBy: fixture.editor.userId,
    });
    // Naming the same owner again changes nothing and records no second transfer.
    await entity(
      await transferOwner(fixture, { policyId: policy.id, serviceAccountId: releaseBot.id }),
      200,
    );
    const version = await fixture.registerVersion('1');
    const job = await fixture.automaticJob(rule, version);
    await fixture.setRole(fixture.editor.userId, 'viewer');
    await fixture.completeJob(job.jobId, { status: 'finished', metrics: { accuracy: 0.9 } });

    const [decision] = await fixture.evaluations({ candidateVersionId: version.id });
    expect(decision).toMatchObject({ decision: 'passed', promoted: true });
    expect((await aliasEvents(fixture))[0]).toMatchObject({
      source: 'promotion_policy',
      actor: { userId: releaseBot.id, displayName: 'release-bot', tokenId: null },
    });
    const audit = await harness.database.query<{
      outcome: string;
      details: Record<string, string>;
    }>("SELECT outcome,details FROM audit_events WHERE action='promotion_policy.owner.transfer'");
    expect(audit.rows).toEqual([
      {
        outcome: 'success',
        details: { previousRunAsUserId: fixture.editor.userId, runAsUserId: releaseBot.id },
      },
    ]);
  });

  it('所有者の移管はProject adminだけで、別Project・無効・admin未満のService Accountは422', async () => {
    const fixture = await promotionFixture(harness);
    const rule = await fixture.registerEvaluationRule('Evaluation A');
    const policy = await fixture.createPolicy(rule);
    const releaseBot = await serviceAccount(fixture, { name: 'release-bot', role: 'admin' });
    const byEditor = await transferOwner(fixture, {
      policyId: policy.id,
      serviceAccountId: releaseBot.id,
      cookie: fixture.editor.cookie,
    });
    expect(byEditor.status).toBe(403);

    const editorBot = await serviceAccount(fixture, { name: 'editor-bot', role: 'editor' });
    const disabledBot = await serviceAccount(fixture, { name: 'disabled-bot', role: 'admin' });
    await entity(
      await request(harness.app, `${fixture.basePath}/service-accounts/${disabledBot.id}`, {
        method: 'PATCH',
        cookie: fixture.administrator.cookie,
        body: { status: 'disabled' },
      }),
      200,
    );
    const otherProject = await entity<Project>(
      await request(harness.app, '/api/projects', {
        method: 'POST',
        cookie: fixture.administrator.cookie,
        body: { name: 'Other Project' },
      }),
    );
    const foreignBot = await serviceAccount(
      { basePath: `/api/projects/${otherProject.id}`, administrator: fixture.administrator },
      { name: 'foreign-bot', role: 'admin' },
    );
    for (const account of [editorBot, disabledBot, foreignBot]) {
      const response = await transferOwner(fixture, {
        policyId: policy.id,
        serviceAccountId: account.id,
      });
      expect(response.status).toBe(422);
      expect(await errorCode(response)).toBe('promotion_owner_invalid');
    }
    const [unchanged] = (
      await entity<{ items: PromotionPolicy[] }>(
        await request(harness.app, `${fixture.basePath}/promotion-policies`, {
          cookie: fixture.viewer.cookie,
        }),
        200,
      )
    ).items;
    expect(unchanged!.runAsUserId).toBe(fixture.administrator.userId);
  });
});
