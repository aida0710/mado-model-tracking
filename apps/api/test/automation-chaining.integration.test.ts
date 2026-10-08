import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type {
  Code,
  CodeVersion,
  Dataset,
  DatasetVersion,
  Job,
  ModelAutomationExecution,
  ModelAutomationRule,
  ModelVersion,
  Experiment,
  Project,
  Run,
  WorkerJob,
} from '@mmt/contracts';
import { MAX_AUTOMATION_CHAIN_DEPTH } from '../src/services/modelAutomationService.js';
import { createHarness, entity, request, testDatabaseUrl, type Harness } from './harness.js';
import {
  automationRuleInput,
  containerCodeInput,
  containerFixture,
  type ContainerFixture,
} from './containerFixtures.js';

describe.skipIf(!testDatabaseUrl)('自動実行の多段連鎖と既存版への手動適用（独立PostgreSQL）', () => {
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

  interface ChainFixture extends ContainerFixture {
    dataset: Dataset;
    referenceSet: DatasetVersion;
  }

  async function chainFixture(): Promise<ChainFixture> {
    const fixture = await containerFixture(harness);
    const dataset = await entity<Dataset>(
      await request(harness.app, `${fixture.basePath}/datasets`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: { name: 'Speech set' },
      }),
    );
    const referenceSet = await registerDatasetVersion(
      { ...fixture, dataset },
      { version: 'reference' },
    );
    return { ...fixture, dataset, referenceSet };
  }

  async function registerDatasetVersion(
    fixture: ContainerFixture & { dataset: Dataset },
    version: { version: string; sourceRunId?: string },
  ): Promise<DatasetVersion> {
    return entity<DatasetVersion>(
      await request(harness.app, `${fixture.basePath}/datasets/${fixture.dataset.id}/versions`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: {
          uri: `s3://datasets/${version.version}`,
          digest: `sha256:${version.version}`,
          ...version,
        },
      }),
    );
  }

  async function createRule(
    fixture: ContainerFixture,
    overrides: Record<string, unknown> = {},
    cookie = fixture.administrator.cookie,
  ): Promise<Response> {
    return request(harness.app, `${fixture.basePath}/automation-rules`, {
      method: 'POST',
      cookie,
      body: automationRuleInput(fixture, overrides),
    });
  }

  // Inference rule A on registration and evaluation rule B chained after A, the usual pipeline.
  async function inferenceAndEvaluationRules(
    fixture: ChainFixture,
  ): Promise<{ inference: ModelAutomationRule; evaluation: ModelAutomationRule }> {
    const inference = await entity<ModelAutomationRule>(await createRule(fixture));
    const evaluation = await entity<ModelAutomationRule>(
      await createRule(fixture, {
        name: 'Chained evaluation',
        kind: 'evaluation',
        trigger: 'upstream_run_finished',
        upstreamRuleId: inference.id,
        inputDatasetVersionIds: [fixture.referenceSet.id],
      }),
    );
    return { inference, evaluation };
  }

  async function registerModel(fixture: ContainerFixture, version = 'weights-v1'): Promise<ModelVersion> {
    return entity<ModelVersion>(
      await request(harness.app, `${fixture.basePath}/models/${fixture.model.id}/versions`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: { version, weightsUri: `https://weights.example.test/${version}.bin` },
      }),
    );
  }

  // Stored executions of one rule, oldest first.
  async function storedExecutions(
    fixture: ContainerFixture,
    ruleId: string,
  ): Promise<ModelAutomationExecution[]> {
    const history = await entity<{ items: ModelAutomationExecution[] }>(
      await request(harness.app, `${fixture.basePath}/automation-executions`, {
        cookie: fixture.viewer.cookie,
      }),
      200,
    );
    return history.items.filter((execution) => execution.ruleId === ruleId).reverse();
  }

  async function getRun(fixture: ContainerFixture, runId: string): Promise<Run> {
    return entity<Run>(
      await request(harness.app, `${fixture.basePath}/runs/${runId}`, {
        cookie: fixture.viewer.cookie,
      }),
      200,
    );
  }

  async function claimJob(fixture: ContainerFixture, expectedRunId: string): Promise<WorkerJob> {
    const claimed = (
      await entity<{ item: WorkerJob }>(
        await request(harness.app, '/api/worker/claim', {
          method: 'POST',
          token: fixture.workerToken,
          body: { workerId: 'chain-worker' },
        }),
        200,
      )
    ).item;
    expect(claimed.job.runId).toBe(expectedRunId);
    return claimed;
  }

  async function completeJob(
    fixture: ContainerFixture,
    claimed: WorkerJob,
    status: 'finished' | 'failed',
  ): Promise<void> {
    await entity(
      await request(harness.app, `/api/worker/jobs/${claimed.job.id}/complete`, {
        method: 'POST',
        token: fixture.workerToken,
        body: { leaseId: claimed.job.leaseId, status, exitCode: status === 'finished' ? 0 : 1 },
      }),
      200,
    );
  }

  // Runs the queued Job of a Run on the test worker; an output DatasetVersion is registered while
  // the Run is still running, as an inference container's result would be.
  async function runJob(
    fixture: ChainFixture,
    job: { runId: string; status: 'finished' | 'failed'; output?: string },
  ): Promise<DatasetVersion | null> {
    const claimed = await claimJob(fixture, job.runId);
    const output = job.output
      ? await registerDatasetVersion(fixture, { version: job.output, sourceRunId: job.runId })
      : null;
    await completeJob(fixture, claimed, job.status);
    return output;
  }

  async function applyRule(
    fixture: ContainerFixture,
    application: { ruleId: string; body: Record<string, string>; cookie?: string },
  ): Promise<Response> {
    return request(
      harness.app,
      `${fixture.basePath}/automation-rules/${application.ruleId}/executions`,
      {
        method: 'POST',
        cookie: application.cookie ?? fixture.administrator.cookie,
        body: application.body,
      },
    );
  }

  async function ruleInAnotherProject(fixture: ContainerFixture): Promise<ModelAutomationRule> {
    const post = async <T>(endpoint: string, body: unknown): Promise<T> =>
      entity<T>(
        await request(harness.app, endpoint, {
          method: 'POST',
          cookie: fixture.administrator.cookie,
          body,
        }),
      );
    const project = await post<Project>('/api/projects', { name: 'Other Project' });
    const basePath = `/api/projects/${project.id}`;
    const experiment = await post<Experiment>(`${basePath}/experiments`, { name: 'Other' });
    const code = await post<Code>(`${basePath}/codes`, { name: 'Other code' });
    const codeVersion = await post<CodeVersion>(
      `${basePath}/codes/${code.id}/versions`,
      containerCodeInput(),
    );
    return post<ModelAutomationRule>(`${basePath}/automation-rules`, {
      ...automationRuleInput(fixture),
      experimentId: experiment.id,
      codeVersionId: codeVersion.id,
    });
  }

  async function errorCode(response: Response): Promise<string> {
    return ((await response.json()) as { code: string }).code;
  }

  async function setRuleEnabled(
    fixture: ContainerFixture,
    rule: { id: string; enabled: boolean },
  ): Promise<void> {
    await entity(
      await request(harness.app, `${fixture.basePath}/automation-rules/${rule.id}`, {
        method: 'PATCH',
        cookie: fixture.administrator.cookie,
        body: { enabled: rule.enabled },
      }),
      200,
    );
  }

  it('推論ruleの登録起動では評価ruleを起動せず、推論Runの出力付き成功で評価を1件だけ起動する', async () => {
    const fixture = await chainFixture();
    const { inference, evaluation } = await inferenceAndEvaluationRules(fixture);
    expect(evaluation).toMatchObject({
      trigger: 'upstream_run_finished',
      upstreamRuleId: inference.id,
      kind: 'evaluation',
    });
    const model = await registerModel(fixture);
    const [inferenceExecution] = await storedExecutions(fixture, inference.id);
    expect(inferenceExecution).toMatchObject({
      status: 'queued',
      triggerRunId: null,
      attempt: 1,
      source: 'automatic',
      requestedBy: null,
    });
    expect(inferenceExecution!.pipelineRootExecutionId).toBe(inferenceExecution!.id);
    expect(await storedExecutions(fixture, evaluation.id)).toEqual([]);

    const output = await runJob(fixture, {
      runId: inferenceExecution!.runId!,
      status: 'finished',
      output: 'predictions',
    });
    const [evaluationExecution] = await storedExecutions(fixture, evaluation.id);
    expect(evaluationExecution).toMatchObject({
      status: 'queued',
      modelVersionId: model.id,
      triggerRunId: inferenceExecution!.runId,
      pipelineRootExecutionId: inferenceExecution!.id,
      attempt: 1,
      source: 'automatic',
    });
    const evaluationRun = await getRun(fixture, evaluationExecution!.runId!);
    expect(evaluationRun).toMatchObject({
      kind: 'evaluation',
      modelVersionId: model.id,
      parentRunId: inferenceExecution!.runId,
      upstreamDatasetVersionIds: [output!.id],
    });
    expect(evaluationRun.inputDatasetVersionIds).toEqual([fixture.referenceSet.id, output!.id]);
    expect(evaluationRun.tags).toMatchObject({
      'automation.ruleId': evaluation.id,
      'automation.pipelineRoot': inferenceExecution!.id,
    });

    // A resent completion must not chain a second evaluation.
    const inferenceJob = (
      await harness.database.query<{ id: string; lease_id: string }>(
        'SELECT id,lease_id FROM jobs WHERE run_id=$1',
        [inferenceExecution!.runId],
      )
    ).rows[0]!;
    await request(harness.app, `/api/worker/jobs/${inferenceJob.id}/complete`, {
      method: 'POST',
      token: fixture.workerToken,
      body: { leaseId: inferenceJob.lease_id, status: 'finished', exitCode: 0 },
    });
    expect(await storedExecutions(fixture, evaluation.id)).toHaveLength(1);
    expect(
      (await harness.database.query("SELECT id FROM runs WHERE kind='evaluation'")).rows,
    ).toHaveLength(1);
  });

  it('上流Runが出力なしで成功したらupstream_outputs_missing、失敗したらupstream_unsuccessfulでskipする', async () => {
    const fixture = await chainFixture();
    const { inference, evaluation } = await inferenceAndEvaluationRules(fixture);
    await registerModel(fixture, 'no-outputs');
    const [withoutOutputs] = await storedExecutions(fixture, inference.id);
    await runJob(fixture, { runId: withoutOutputs!.runId!, status: 'finished' });
    await registerModel(fixture, 'failing');
    const failing = (await storedExecutions(fixture, inference.id))[1]!;
    await runJob(fixture, { runId: failing.runId!, status: 'failed' });

    const skipped = await storedExecutions(fixture, evaluation.id);
    expect(skipped).toEqual([
      expect.objectContaining({
        status: 'skipped',
        triggerRunId: withoutOutputs!.runId,
        pipelineRootExecutionId: withoutOutputs!.id,
        runId: null,
        jobId: null,
      }),
      expect.objectContaining({ status: 'skipped', triggerRunId: failing.runId }),
    ]);
    expect(skipped[0]!.error).toMatch(/^upstream_outputs_missing:/);
    expect(skipped[1]!.error).toMatch(/^upstream_unsuccessful:/);
    expect(
      (await harness.database.query("SELECT id FROM runs WHERE kind='evaluation'")).rows,
    ).toHaveLength(0);
  });

  it('失敗した上流Runを手動retryして成功すると、retryのRunを上流として評価を起動する', async () => {
    const fixture = await chainFixture();
    const { inference, evaluation } = await inferenceAndEvaluationRules(fixture);
    await registerModel(fixture);
    const [original] = await storedExecutions(fixture, inference.id);
    await runJob(fixture, { runId: original!.runId!, status: 'failed' });
    const retried = await entity<{ run: Run; job: Job }>(
      await request(harness.app, `${fixture.basePath}/jobs/${original!.jobId}/retry`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
      }),
    );
    const output = await runJob(fixture, {
      runId: retried.run.id,
      status: 'finished',
      output: 'retried-predictions',
    });

    const executions = await storedExecutions(fixture, evaluation.id);
    expect(executions.map((execution) => [execution.status, execution.triggerRunId])).toEqual([
      ['skipped', original!.runId],
      ['queued', retried.run.id],
    ]);
    const evaluationRun = await getRun(fixture, executions[1]!.runId!);
    expect(evaluationRun).toMatchObject({
      parentRunId: retried.run.id,
      upstreamDatasetVersionIds: [output!.id],
    });
    expect(executions[1]!.pipelineRootExecutionId).toBe(original!.id);
  });

  it('連鎖で起動した評価Runを手動retryしても、上流の出力は正解セットと分けて引き継ぐ', async () => {
    const fixture = await chainFixture();
    const { inference, evaluation } = await inferenceAndEvaluationRules(fixture);
    await registerModel(fixture);
    const [upstream] = await storedExecutions(fixture, inference.id);
    const output = await runJob(fixture, {
      runId: upstream!.runId!,
      status: 'finished',
      output: 'predictions',
    });
    const [chained] = await storedExecutions(fixture, evaluation.id);
    await runJob(fixture, { runId: chained!.runId!, status: 'failed' });
    const retried = await entity<{ run: Run; job: Job }>(
      await request(harness.app, `${fixture.basePath}/jobs/${chained!.jobId}/retry`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
      }),
    );

    const original = await getRun(fixture, chained!.runId!);
    expect(retried.run.upstreamDatasetVersionIds).toEqual([output!.id]);
    expect(retried.run.inputDatasetVersionIds).toEqual(original.inputDatasetVersionIds);
  });

  it('予約tag拒否の前にautomation.ruleIdを付けた手動Runが成功しても、評価ruleは起動しない', async () => {
    const fixture = await chainFixture();
    const { inference, evaluation } = await inferenceAndEvaluationRules(fixture);
    const model = await registerModel(fixture);
    const manual = await entity<Run>(
      await request(harness.app, `${fixture.basePath}/runs`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: {
          experimentId: fixture.experiment.id,
          name: 'Hand-made inference',
          kind: 'inference',
          modelVersionId: model.id,
        },
      }),
    );
    await harness.database.query(
      `UPDATE runs SET tags=tags||jsonb_build_object('automation.ruleId',$2::text) WHERE id=$1`,
      [manual.id, inference.id],
    );
    await registerDatasetVersion(fixture, { version: 'hand-made', sourceRunId: manual.id });
    for (const status of ['running', 'finished'])
      await entity(
        await request(harness.app, `${fixture.basePath}/runs/${manual.id}`, {
          method: 'PATCH',
          cookie: fixture.editor.cookie,
          body: { status },
        }),
        200,
      );
    expect(await storedExecutions(fixture, evaluation.id)).toEqual([]);
  });

  it('上流ruleが無効になっていれば、その上流Runが成功しても評価ruleを起動しない', async () => {
    const fixture = await chainFixture();
    const { inference, evaluation } = await inferenceAndEvaluationRules(fixture);
    await registerModel(fixture);
    const [execution] = await storedExecutions(fixture, inference.id);
    await setRuleEnabled(fixture, { id: inference.id, enabled: false });
    await runJob(fixture, { runId: execution!.runId!, status: 'finished', output: 'predictions' });
    expect(await storedExecutions(fixture, evaluation.id)).toEqual([]);
  });

  it(`連鎖の作成時に段数（${MAX_AUTOMATION_CHAIN_DEPTH}段）超過・循環・無効な上流は422、別Projectの上流は404にする`, async () => {
    const fixture = await chainFixture();
    let upstream = await entity<ModelAutomationRule>(await createRule(fixture));
    for (let depth = 2; depth <= MAX_AUTOMATION_CHAIN_DEPTH; depth += 1)
      upstream = await entity<ModelAutomationRule>(
        await createRule(fixture, {
          name: `Stage ${depth}`,
          trigger: 'upstream_run_finished',
          upstreamRuleId: upstream.id,
        }),
      );
    const tooDeep = await createRule(fixture, {
      trigger: 'upstream_run_finished',
      upstreamRuleId: upstream.id,
    });
    expect(tooDeep.status).toBe(422);
    expect(await errorCode(tooDeep)).toBe('automation_chain_too_deep');

    for (const body of [
      { trigger: 'upstream_run_finished' },
      { trigger: 'model_registered', upstreamRuleId: upstream.id },
    ]) {
      const inconsistent = await createRule(fixture, body);
      expect(inconsistent.status).toBe(422);
      expect(await errorCode(inconsistent)).toBe('invalid_automation_trigger');
    }

    const first = await entity<ModelAutomationRule>(await createRule(fixture, { name: 'Loop A' }));
    const second = await entity<ModelAutomationRule>(
      await createRule(fixture, {
        name: 'Loop B',
        trigger: 'upstream_run_finished',
        upstreamRuleId: first.id,
      }),
    );
    // Immutable rules cannot form a cycle through the API; edit the rows directly to prove the
    // depth walk still reports one instead of recursing.
    await harness.database.query(
      'ALTER TABLE model_automation_rules DISABLE TRIGGER automation_rules_immutable',
    );
    try {
      await harness.database.query(
        `UPDATE model_automation_rules SET trigger='upstream_run_finished',upstream_rule_id=$2 WHERE id=$1`,
        [first.id, second.id],
      );
    } finally {
      await harness.database.query(
        'ALTER TABLE model_automation_rules ENABLE TRIGGER automation_rules_immutable',
      );
    }
    const cyclic = await createRule(fixture, {
      trigger: 'upstream_run_finished',
      upstreamRuleId: second.id,
    });
    expect(cyclic.status).toBe(422);
    expect(await errorCode(cyclic)).toBe('automation_chain_cycle');

    const disabled = await entity<ModelAutomationRule>(
      await createRule(fixture, { name: 'Disabled upstream', enabled: false }),
    );
    const fromDisabled = await createRule(fixture, {
      trigger: 'upstream_run_finished',
      upstreamRuleId: disabled.id,
    });
    expect(fromDisabled.status).toBe(422);
    expect(await errorCode(fromDisabled)).toBe('upstream_rule_disabled');

    const otherRule = await ruleInAnotherProject(fixture);
    const crossProject = await createRule(fixture, {
      trigger: 'upstream_run_finished',
      upstreamRuleId: otherRule.id,
    });
    expect(crossProject.status).toBe(404);
  });

  it('既存の版への手動適用はProject adminだけが行え、実行中は409、無効ruleは422、attemptが増える', async () => {
    const fixture = await chainFixture();
    const model = await registerModel(fixture, 'registered-before-rule');
    const { inference, evaluation } = await inferenceAndEvaluationRules(fixture);
    expect(await storedExecutions(fixture, inference.id)).toEqual([]);

    const byEditor = await applyRule(fixture, {
      ruleId: inference.id,
      body: { modelVersionId: model.id },
      cookie: fixture.editor.cookie,
    });
    expect(byEditor.status).toBe(403);

    const first = await entity<ModelAutomationExecution>(
      await applyRule(fixture, { ruleId: inference.id, body: { modelVersionId: model.id } }),
    );
    expect(first).toMatchObject({
      status: 'queued',
      source: 'manual',
      attempt: 1,
      requestedBy: fixture.administrator.userId,
      triggerRunId: null,
      pipelineRootExecutionId: first.id,
    });
    const active = await applyRule(fixture, {
      ruleId: inference.id,
      body: { modelVersionId: model.id },
    });
    expect(active.status).toBe(409);
    expect(await errorCode(active)).toBe('automation_execution_active');

    // The manually started inference still chains into evaluation when it succeeds.
    await runJob(fixture, { runId: first.runId!, status: 'finished', output: 'predictions' });
    const [chained] = await storedExecutions(fixture, evaluation.id);
    expect(chained).toMatchObject({
      status: 'queued',
      source: 'automatic',
      triggerRunId: first.runId,
      pipelineRootExecutionId: first.id,
    });

    const second = await entity<ModelAutomationExecution>(
      await applyRule(fixture, { ruleId: inference.id, body: { modelVersionId: model.id } }),
    );
    expect(second).toMatchObject({ status: 'queued', source: 'manual', attempt: 2 });

    await setRuleEnabled(fixture, { id: inference.id, enabled: false });
    const disabled = await applyRule(fixture, {
      ruleId: inference.id,
      body: { modelVersionId: model.id },
    });
    expect(disabled.status).toBe(422);
    expect(await errorCode(disabled)).toBe('automation_rule_disabled');

    const audit = await harness.database.query(
      `SELECT outcome,details FROM audit_events WHERE action='automation.execution.manual' ORDER BY occurred_at,id`,
    );
    expect(audit.rows.map((row: { outcome: string }) => row.outcome)).toEqual([
      'denied',
      'success',
      'denied',
      'success',
    ]);
  });

  it('連鎖ruleの手動適用は上流Run（triggerRunId）を受け、評価コードを直した新しいruleで基準版の推論から評価を回せる', async () => {
    const fixture = await chainFixture();
    const { inference, evaluation } = await inferenceAndEvaluationRules(fixture);
    const model = await registerModel(fixture);
    const [inferenceExecution] = await storedExecutions(fixture, inference.id);
    const output = await runJob(fixture, {
      runId: inferenceExecution!.runId!,
      status: 'finished',
      output: 'predictions',
    });
    const busy = await applyRule(fixture, {
      ruleId: evaluation.id,
      body: { triggerRunId: inferenceExecution!.runId! },
    });
    expect(busy.status).toBe(409);

    const fixedEvaluation = await entity<ModelAutomationRule>(
      await createRule(fixture, {
        name: 'Fixed evaluation',
        kind: 'evaluation',
        trigger: 'upstream_run_finished',
        upstreamRuleId: inference.id,
        inputDatasetVersionIds: [fixture.referenceSet.id],
      }),
    );
    const byVersion = await applyRule(fixture, {
      ruleId: fixedEvaluation.id,
      body: { modelVersionId: model.id },
    });
    expect(byVersion.status).toBe(422);
    expect(await errorCode(byVersion)).toBe('automation_trigger_mismatch');

    const applied = await entity<ModelAutomationExecution>(
      await applyRule(fixture, {
        ruleId: fixedEvaluation.id,
        body: { triggerRunId: inferenceExecution!.runId! },
      }),
    );
    expect(applied).toMatchObject({
      status: 'queued',
      source: 'manual',
      attempt: 1,
      modelVersionId: model.id,
      triggerRunId: inferenceExecution!.runId,
      pipelineRootExecutionId: inferenceExecution!.id,
    });
    expect(await getRun(fixture, applied.runId!)).toMatchObject({
      parentRunId: inferenceExecution!.runId,
      inputDatasetVersionIds: [fixture.referenceSet.id, output!.id],
      upstreamDatasetVersionIds: [output!.id],
    });

    // A Run the upstream rule did not create cannot stand in for the upstream stage.
    const handMade = await entity<Run>(
      await request(harness.app, `${fixture.basePath}/runs`, {
        method: 'POST',
        cookie: fixture.editor.cookie,
        body: { experimentId: fixture.experiment.id, name: 'Hand-made', kind: 'inference' },
      }),
    );
    for (const status of ['running', 'finished'])
      await entity(
        await request(harness.app, `${fixture.basePath}/runs/${handMade.id}`, {
          method: 'PATCH',
          cookie: fixture.editor.cookie,
          body: { status },
        }),
        200,
      );
    const mismatch = await applyRule(fixture, {
      ruleId: fixedEvaluation.id,
      body: { triggerRunId: handMade.id },
    });
    expect(mismatch.status).toBe(422);
    expect(await errorCode(mismatch)).toBe('upstream_rule_mismatch');
  });

  it('作成者のProject adminがgroup bindingによるものでも、作成者権限ありとして起動する', async () => {
    const fixture = await chainFixture();
    await entity(
      await request(harness.app, `${fixture.basePath}/members/${fixture.editor.userId}`, {
        method: 'PUT',
        cookie: fixture.administrator.cookie,
        body: { role: 'admin' },
      }),
      200,
    );
    const rule = await entity<ModelAutomationRule>(
      await createRule(fixture, {}, fixture.editor.cookie),
    );
    await harness.database.query(
      `UPDATE project_members SET role='editor' WHERE project_id=$1 AND user_id=$2`,
      [fixture.project.id, fixture.editor.userId],
    );
    await registerModel(fixture, 'direct-editor');
    await harness.database.query(
      `INSERT INTO user_groups(user_id,group_name) VALUES($1,'mmt-speech-admins')`,
      [fixture.editor.userId],
    );
    await harness.database.query(
      `INSERT INTO project_group_bindings(project_id,group_name,role,created_by) VALUES($1,'mmt-speech-admins','admin',$2)`,
      [fixture.project.id, fixture.administrator.userId],
    );
    await registerModel(fixture, 'group-admin');
    const executions = await storedExecutions(fixture, rule.id);
    expect(executions.map((execution) => execution.status)).toEqual(['skipped', 'queued']);
    expect(executions[0]!.error).toMatch(/^creator_access_revoked:/);
  });
});
