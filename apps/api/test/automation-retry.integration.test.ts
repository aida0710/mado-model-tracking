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
  Project,
  Run,
  ServiceAccount,
  WorkerJob,
} from '@mmt/contracts';
import { transaction } from '../src/db/database.js';
import { createHarness, entity, login, request, testDatabaseUrl, type Harness } from './harness.js';
import {
  automationRuleInput,
  containerCodeInput,
  containerFixture,
  type ContainerFixture,
} from './containerFixtures.js';

describe.skipIf(!testDatabaseUrl)(
  '自動実行の自動再試行とruleの所有者の移管（独立PostgreSQL）',
  () => {
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

    async function createRule(
      fixture: ContainerFixture,
      overrides: Record<string, unknown> = {},
      cookie = fixture.administrator.cookie,
    ): Promise<ModelAutomationRule> {
      return entity<ModelAutomationRule>(
        await request(harness.app, `${fixture.basePath}/automation-rules`, {
          method: 'POST',
          cookie,
          body: automationRuleInput(fixture, overrides),
        }),
      );
    }

    async function registerModel(
      fixture: ContainerFixture,
      version = 'weights-v1',
      body: Record<string, unknown> = { weightsUri: `https://weights.example.test/${version}.bin` },
    ): Promise<ModelVersion> {
      return entity<ModelVersion>(
        await request(harness.app, `${fixture.basePath}/models/${fixture.model.id}/versions`, {
          method: 'POST',
          cookie: fixture.editor.cookie,
          body: { version, ...body },
        }),
      );
    }

    // Stored executions of one rule, oldest first.
    async function storedExecutions(
      fixture: ContainerFixture,
      ruleId: string,
    ): Promise<ModelAutomationExecution[]> {
      const history = await entity<{ items: ModelAutomationExecution[] }>(
        await request(harness.app, `${fixture.basePath}/automation-executions?ruleId=${ruleId}`, {
          cookie: fixture.viewer.cookie,
        }),
        200,
      );
      return history.items.reverse();
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
            body: { workerId: 'retry-worker' },
          }),
          200,
        )
      ).item;
      expect(claimed.job.runId).toBe(expectedRunId);
      return claimed;
    }

    function completeJob(
      fixture: ContainerFixture,
      claimed: WorkerJob,
      status: 'finished' | 'failed',
    ): Promise<Response> {
      return request(harness.app, `/api/worker/jobs/${claimed.job.id}/complete`, {
        method: 'POST',
        token: fixture.workerToken,
        body: { leaseId: claimed.job.leaseId, status, exitCode: status === 'finished' ? 0 : 1 },
      });
    }

    async function runJob(
      fixture: ContainerFixture,
      job: {
        runId: string;
        status: 'finished' | 'failed';
        output?: { dataset: Dataset; version: string };
      },
    ): Promise<WorkerJob> {
      const claimed = await claimJob(fixture, job.runId);
      if (job.output)
        await entity<DatasetVersion>(
          await request(
            harness.app,
            `${fixture.basePath}/datasets/${job.output.dataset.id}/versions`,
            {
              method: 'POST',
              cookie: fixture.editor.cookie,
              body: {
                version: job.output.version,
                uri: `s3://datasets/${job.output.version}`,
                digest: `sha256:${job.output.version}`,
                sourceRunId: job.runId,
              },
            },
          ),
        );
      await entity(await completeJob(fixture, claimed, job.status), 200);
      return claimed;
    }

    async function countRows(table: 'runs' | 'jobs'): Promise<number> {
      const result = await harness.database.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM ${table}`,
      );
      return result.rows[0]!.count;
    }

    async function serviceAccount(
      fixture: { basePath: string; administrator: { cookie: string } },
      account: { name: string; role: 'viewer' | 'editor' | 'admin' },
    ): Promise<ServiceAccount> {
      return entity<ServiceAccount>(
        await request(harness.app, `${fixture.basePath}/service-accounts`, {
          method: 'POST',
          cookie: fixture.administrator.cookie,
          body: { ...account, description: `${account.name} for tests` },
        }),
      );
    }

    function transferOwner(
      fixture: ContainerFixture,
      transfer: { ruleId: string; serviceAccountId: string; cookie?: string },
    ): Promise<Response> {
      return request(harness.app, `${fixture.basePath}/automation-rules/${transfer.ruleId}/owner`, {
        method: 'PUT',
        cookie: transfer.cookie ?? fixture.administrator.cookie,
        body: { serviceAccountId: transfer.serviceAccountId },
      });
    }

    // A Project admin who is not a global administrator, so removing them revokes the rule owner.
    async function projectAdmin(
      fixture: ContainerFixture,
    ): Promise<{ cookie: string; userId: string }> {
      const owner = await login(harness, 'rule-owner@localhost');
      await entity(
        await request(harness.app, `${fixture.basePath}/members/${owner.userId}`, {
          method: 'PUT',
          cookie: fixture.administrator.cookie,
          body: { role: 'admin' },
        }),
        200,
      );
      return owner;
    }

    async function removeMember(fixture: ContainerFixture, userId: string): Promise<void> {
      const removed = await request(harness.app, `${fixture.basePath}/members/${userId}`, {
        method: 'DELETE',
        cookie: fixture.administrator.cookie,
      });
      expect(removed.status).toBe(204);
    }

    it('maxAttempts=2のruleはfailedで次のattemptのRunとJobを1件だけ作り、maxAttemptsで止まる', async () => {
      const fixture = await containerFixture(harness);
      const rule = await createRule(fixture, { maxAttempts: 2 });
      const model = await registerModel(fixture);
      const [first] = await storedExecutions(fixture, rule.id);
      const firstRun = await getRun(fixture, first!.runId!);
      const runsBefore = await countRows('runs');

      await runJob(fixture, { runId: first!.runId!, status: 'failed' });

      expect(await countRows('runs')).toBe(runsBefore + 1);
      const executions = await storedExecutions(fixture, rule.id);
      expect(executions).toHaveLength(2);
      const retry = executions[1]!;
      expect(retry).toMatchObject({
        status: 'queued',
        attempt: 2,
        source: 'automatic',
        requestedBy: null,
        retryOfExecutionId: first!.id,
        modelVersionId: model.id,
        triggerRunId: null,
        pipelineRootExecutionId: first!.id,
        jobStatus: 'queued',
      });
      const jobs = await harness.database.query<{ retry_of_job_id: string; attempt: number }>(
        'SELECT retry_of_job_id,attempt FROM jobs WHERE id=$1',
        [retry.jobId],
      );
      expect(jobs.rows[0]).toEqual({ retry_of_job_id: first!.jobId, attempt: 2 });
      const retryRun = await getRun(fixture, retry.runId!);
      // The retry keeps the automated Run's upstream instead of hanging under the failed Run.
      expect(retryRun).toMatchObject({
        parentRunId: firstRun.parentRunId,
        createdBy: rule.runAsUserId,
        resumeCheckpointId: null,
      });

      await runJob(fixture, { runId: retry.runId!, status: 'failed' });
      expect(await storedExecutions(fixture, rule.id)).toHaveLength(2);
      expect(await countRows('runs')).toBe(runsBefore + 1);
    });

    it('maxAttemptsを省いたruleは既定の1で、失敗しても自動では再試行しない', async () => {
      const fixture = await containerFixture(harness);
      const rule = await createRule(fixture);
      expect(rule).toMatchObject({ maxAttempts: 1, runAsUserId: fixture.administrator.userId });
      await registerModel(fixture);
      const [first] = await storedExecutions(fixture, rule.id);
      const jobsBefore = await countRows('jobs');

      await runJob(fixture, { runId: first!.runId!, status: 'failed' });

      expect(await storedExecutions(fixture, rule.id)).toHaveLength(1);
      expect(await countRows('jobs')).toBe(jobsBefore);
      // People can still retry the automated Job by hand.
      await entity(
        await request(harness.app, `${fixture.basePath}/jobs/${first!.jobId}/retry`, {
          method: 'POST',
          cookie: fixture.editor.cookie,
        }),
      );
    });

    it('中止したRunは再試行しない', async () => {
      const fixture = await containerFixture(harness);
      const rule = await createRule(fixture, { maxAttempts: 3 });
      await registerModel(fixture);
      const [first] = await storedExecutions(fixture, rule.id);

      await entity(
        await request(harness.app, `${fixture.basePath}/jobs/${first!.jobId}/cancel`, {
          method: 'POST',
          cookie: fixture.editor.cookie,
        }),
        200,
      );

      expect((await getRun(fixture, first!.runId!)).status).toBe('canceled');
      expect(await storedExecutions(fixture, rule.id)).toHaveLength(1);
    });

    it('completeの再送や同じRunの2回目の終端では二重に再試行しない', async () => {
      const fixture = await containerFixture(harness);
      const rule = await createRule(fixture, { maxAttempts: 3 });
      await registerModel(fixture);
      const [first] = await storedExecutions(fixture, rule.id);
      const claimed = await runJob(fixture, { runId: first!.runId!, status: 'failed' });

      await entity(await completeJob(fixture, claimed, 'failed'), 200);
      const failedRun = await getRun(fixture, first!.runId!);
      // An MLflow reopen/finish cycle reaches the terminal handlers again for the same Run.
      await transaction(harness.database, (connection) =>
        harness.services.runCompletion.recordStatusChange(connection, {
          previousStatus: 'running',
          run: failedRun,
        }),
      );

      const executions = await storedExecutions(fixture, rule.id);
      expect(executions.map((execution) => execution.attempt)).toEqual([1, 2]);
      const retries = await harness.database.query('SELECT id FROM jobs WHERE retry_of_job_id=$1', [
        first!.jobId,
      ]);
      expect(retries.rows).toHaveLength(1);
    });

    it('予約tagを付けた手動Runの失敗では再試行しない', async () => {
      const fixture = await containerFixture(harness);
      const rule = await createRule(fixture, { maxAttempts: 3 });
      const run = await entity<Run>(
        await request(harness.app, `${fixture.basePath}/runs`, {
          method: 'POST',
          cookie: fixture.editor.cookie,
          body: {
            experimentId: fixture.experiment.id,
            name: 'Hand-made inference',
            kind: 'inference',
            modelVersionId: fixture.modelVersion.id,
            codeVersionId: fixture.containerCodeVersion.id,
          },
        }),
      );
      // Tags written before reserved tags were enforced; the API refuses them today.
      await harness.database.query(
        `UPDATE runs SET tags=tags||jsonb_build_object('automation.ruleId',$2::text) WHERE id=$1`,
        [run.id, rule.id],
      );
      await entity<Job>(
        await request(harness.app, `${fixture.basePath}/jobs`, {
          method: 'POST',
          cookie: fixture.editor.cookie,
          body: { runId: run.id, targetId: fixture.target.id, gpuIds: [] },
        }),
      );
      const jobsBefore = await countRows('jobs');

      await runJob(fixture, { runId: run.id, status: 'failed' });

      expect(await countRows('jobs')).toBe(jobsBefore);
      expect(await storedExecutions(fixture, rule.id)).toEqual([]);
    });

    it('再試行したRunが成功すると連鎖の下流を1件だけ起動する', async () => {
      const fixture = await containerFixture(harness);
      const dataset = await entity<Dataset>(
        await request(harness.app, `${fixture.basePath}/datasets`, {
          method: 'POST',
          cookie: fixture.editor.cookie,
          body: { name: 'Predictions' },
        }),
      );
      const inference = await createRule(fixture, { maxAttempts: 2 });
      const evaluation = await createRule(fixture, {
        name: 'Chained evaluation',
        kind: 'evaluation',
        trigger: 'upstream_run_finished',
        upstreamRuleId: inference.id,
      });
      await registerModel(fixture);
      const [first] = await storedExecutions(fixture, inference.id);
      await runJob(fixture, { runId: first!.runId!, status: 'failed' });
      const [, retry] = await storedExecutions(fixture, inference.id);

      await runJob(fixture, {
        runId: retry!.runId!,
        status: 'finished',
        output: { dataset, version: 'predictions' },
      });

      const downstream = await storedExecutions(fixture, evaluation.id);
      const started = downstream.filter((execution) => execution.status === 'queued');
      expect(started).toHaveLength(1);
      expect(started[0]).toMatchObject({
        triggerRunId: retry!.runId,
        pipelineRootExecutionId: first!.id,
      });
      expect((await getRun(fixture, started[0]!.runId!)).parentRunId).toBe(retry!.runId);
    });

    it('連鎖の評価Runを手動retryしても、retryのRunの親は上流の推論Runのまま', async () => {
      const fixture = await containerFixture(harness);
      const dataset = await entity<Dataset>(
        await request(harness.app, `${fixture.basePath}/datasets`, {
          method: 'POST',
          cookie: fixture.editor.cookie,
          body: { name: 'Predictions' },
        }),
      );
      const inference = await createRule(fixture);
      const evaluation = await createRule(fixture, {
        name: 'Chained evaluation',
        kind: 'evaluation',
        trigger: 'upstream_run_finished',
        upstreamRuleId: inference.id,
      });
      await registerModel(fixture);
      const [upstream] = await storedExecutions(fixture, inference.id);
      await runJob(fixture, {
        runId: upstream!.runId!,
        status: 'finished',
        output: { dataset, version: 'predictions' },
      });
      const [chained] = await storedExecutions(fixture, evaluation.id);
      await runJob(fixture, { runId: chained!.runId!, status: 'failed' });

      const retried = await entity<{ run: Run; job: Job }>(
        await request(harness.app, `${fixture.basePath}/jobs/${chained!.jobId}/retry`, {
          method: 'POST',
          cookie: fixture.editor.cookie,
        }),
      );

      expect(retried.run).toMatchObject({
        parentRunId: upstream!.runId,
        createdBy: fixture.editor.userId,
      });
    });

    it('自動実行を開始できなかったときにautomation.failedの通知をoutboxへ積む', async () => {
      const fixture = await containerFixture(harness);
      const channel = await entity<{ id: string }>(
        await request(harness.app, '/api/notification-channels', {
          method: 'POST',
          cookie: fixture.administrator.cookie,
          body: { kind: 'slack_webhook', name: 'ops', urlEnv: 'MMT_NOTIFICATION_SLACK_URL' },
        }),
      );
      await entity(
        await request(harness.app, `${fixture.basePath}/notification-rules`, {
          method: 'POST',
          cookie: fixture.administrator.cookie,
          body: {
            channelId: channel.id,
            eventTypes: ['automation.failed'],
            filter: { runKinds: ['inference'], automationOnly: true },
          },
        }),
      );
      const rule = await createRule(fixture);
      // A version without weights cannot start inference.
      const model = await registerModel(fixture, 'no-weights', {});

      const [execution] = await storedExecutions(fixture, rule.id);
      expect(execution).toMatchObject({ status: 'skipped' });
      const outbox = await harness.database.query<{
        event_type: string;
        dedupe_key: string;
        event: { title: string; details: Record<string, unknown>; url: string };
      }>('SELECT event_type,dedupe_key,event FROM notification_outbox');
      expect(outbox.rows).toHaveLength(1);
      expect(outbox.rows[0]).toMatchObject({
        event_type: 'automation.failed',
        dedupe_key: `automation.failed:${execution!.id}`,
        event: {
          details: {
            executionId: execution!.id,
            ruleId: rule.id,
            modelVersionId: model.id,
            status: 'skipped',
            reason: 'weights_required',
          },
        },
      });
      expect(outbox.rows[0]!.event.url).toContain(`/versions/${model.id}`);
    });

    it('所有者をService Accountへ移すと、作成者をProjectから外しても自動実行が続く', async () => {
      const fixture = await containerFixture(harness);
      const owner = await projectAdmin(fixture);
      const rule = await createRule(fixture, {}, owner.cookie);
      expect(rule).toMatchObject({ runAsUserId: owner.userId, runAsKind: 'human' });
      const account = await serviceAccount(fixture, { name: 'automation-bot', role: 'admin' });

      const transferred = await entity<ModelAutomationRule>(
        await transferOwner(fixture, { ruleId: rule.id, serviceAccountId: account.id }),
        200,
      );
      expect(transferred).toMatchObject({
        createdBy: owner.userId,
        runAsUserId: account.id,
        runAsKind: 'service',
        runAsName: 'automation-bot',
      });
      // The creator is named for the rule detail, not only by id.
      const creator = await harness.database.query<{ display_name: string }>(
        'SELECT display_name FROM users WHERE id=$1',
        [owner.userId],
      );
      expect(transferred.createdByName).toBe(creator.rows[0]!.display_name);
      // Setting the same owner again is a no-op and is not audited twice.
      await entity(
        await transferOwner(fixture, { ruleId: rule.id, serviceAccountId: account.id }),
        200,
      );
      const audits = await harness.database.query<{ details: Record<string, unknown> }>(
        `SELECT details FROM audit_events WHERE action='automation_rule.owner.transfer' AND outcome='success'`,
      );
      expect(audits.rows).toHaveLength(1);
      expect(audits.rows[0]!.details).toMatchObject({
        serviceAccountId: account.id,
        previousRunAsUserId: owner.userId,
      });
      await removeMember(fixture, owner.userId);

      await registerModel(fixture);

      const [execution] = await storedExecutions(fixture, rule.id);
      expect(execution).toMatchObject({ status: 'queued', error: null });
      expect((await getRun(fixture, execution!.runId!)).createdBy).toBe(account.id);
    });

    it('所有者が権限を失ったruleは再試行もskipして記録する', async () => {
      const fixture = await containerFixture(harness);
      const owner = await projectAdmin(fixture);
      const rule = await createRule(fixture, { maxAttempts: 2 }, owner.cookie);
      await registerModel(fixture);
      const [first] = await storedExecutions(fixture, rule.id);
      await removeMember(fixture, owner.userId);
      const jobsBefore = await countRows('jobs');

      await runJob(fixture, { runId: first!.runId!, status: 'failed' });

      const [, retry] = await storedExecutions(fixture, rule.id);
      expect(retry).toMatchObject({
        status: 'skipped',
        attempt: 2,
        retryOfExecutionId: first!.id,
        error: expect.stringMatching(/^creator_access_revoked:/),
      });
      expect(await countRows('jobs')).toBe(jobsBefore);
    });

    it('所有者の移管はProject adminだけができ、editorは403になる', async () => {
      const fixture = await containerFixture(harness);
      const rule = await createRule(fixture);
      const account = await serviceAccount(fixture, { name: 'automation-bot', role: 'admin' });

      const denied = await transferOwner(fixture, {
        ruleId: rule.id,
        serviceAccountId: account.id,
        cookie: fixture.editor.cookie,
      });

      expect(denied.status).toBe(403);
      const rules = await entity<{ items: ModelAutomationRule[] }>(
        await request(harness.app, `${fixture.basePath}/automation-rules`, {
          cookie: fixture.viewer.cookie,
        }),
        200,
      );
      expect(rules.items[0]).toMatchObject({ runAsUserId: fixture.administrator.userId });
      const audits = await harness.database.query(
        `SELECT id FROM audit_events WHERE action='automation_rule.owner.transfer' AND outcome='denied'`,
      );
      expect(audits.rows).toHaveLength(1);
    });

    it('別Project・無効・admin未満のService Accountへは移せず422になる', async () => {
      const fixture = await containerFixture(harness);
      const rule = await createRule(fixture);
      const editorAccount = await serviceAccount(fixture, { name: 'editor-bot', role: 'editor' });
      const disabledAccount = await serviceAccount(fixture, {
        name: 'disabled-bot',
        role: 'admin',
      });
      await entity(
        await request(harness.app, `${fixture.basePath}/service-accounts/${disabledAccount.id}`, {
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
      const foreignAccount = await serviceAccount(
        { basePath: `/api/projects/${otherProject.id}`, administrator: fixture.administrator },
        { name: 'foreign-bot', role: 'admin' },
      );

      for (const account of [editorAccount, disabledAccount, foreignAccount]) {
        const response = await transferOwner(fixture, {
          ruleId: rule.id,
          serviceAccountId: account.id,
        });
        expect(response.status).toBe(422);
        expect(((await response.json()) as { code: string }).code).toBe('invalid_automation_owner');
      }
      // A person is not a Service Account either.
      const person = await transferOwner(fixture, {
        ruleId: rule.id,
        serviceAccountId: fixture.editor.userId,
      });
      expect(person.status).toBe(422);
    });

    it('ruleの設定は所有者の移管以外では変えられない', async () => {
      const fixture = await containerFixture(harness);
      const rule = await createRule(fixture);
      const otherCode = await entity<Code>(
        await request(harness.app, `${fixture.basePath}/codes`, {
          method: 'POST',
          cookie: fixture.editor.cookie,
          body: { name: 'Other code' },
        }),
      );
      const otherVersion = await entity<CodeVersion>(
        await request(harness.app, `${fixture.basePath}/codes/${otherCode.id}/versions`, {
          method: 'POST',
          cookie: fixture.editor.cookie,
          body: containerCodeInput(),
        }),
      );

      await expect(
        harness.database.query('UPDATE model_automation_rules SET code_version_id=$2 WHERE id=$1', [
          rule.id,
          otherVersion.id,
        ]),
      ).rejects.toThrow(/immutable/);
    });
  },
);
