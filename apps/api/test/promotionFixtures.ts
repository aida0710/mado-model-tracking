import { expect } from 'vitest';
import type {
  Dataset,
  DatasetVersion,
  ModelAutomationRule,
  ModelVersion,
  PromotionEvaluation,
  PromotionEvaluationPage,
  PromotionPolicy,
  WorkerJob,
} from '@mmt/contracts';
import { entity, request, type Harness } from './harness.js';
import { automationRuleInput, containerFixture } from './containerFixtures.js';

// A Project with an evaluation reference set, a worker, and helpers that drive promotion policies
// and automatic evaluation Jobs to completion. Shared by the promotion and auto-promotion tests.

// Enough parallel claims for every automatic Job a test starts.
const TEST_TARGET_CONCURRENCY = 20;

export async function promotionFixture(harness: Harness) {
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
    return request(harness.app, `${basePath}/promotion-policies`, {
      method: 'POST',
      ...auth,
      body,
    });
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
        await request(
          harness.app,
          `${basePath}/promotion-evaluations${search ? `?${search}` : ''}`,
          {
            cookie: viewer.cookie,
          },
        ),
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

export type PromotionFixture = Awaited<ReturnType<typeof promotionFixture>>;
