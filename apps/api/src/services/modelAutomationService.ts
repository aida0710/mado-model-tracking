import { randomUUID } from 'node:crypto';
import type {
  AutomationRuleOwnerTransfer,
  Job,
  ModelAutomationExecution,
  ModelAutomationExecutionPage,
  ModelAutomationRule,
  ModelVersion,
  Run,
} from '@mmt/contracts';
import type { Principal } from '../auth/principal.js';
import { first, transaction, type Connection, type Database } from '../db/database.js';
import { automationFailureMessage } from '../domain/automationFailure.js';
import { validateCodeCompatibility } from '../domain/compatibility.js';
import { DomainError, notFound } from '../domain/errors.js';
import {
  assertRuleTrigger,
  type AutomationExecutionCreate,
  type AutomationExecutionQuery,
  type ModelAutomationRuleCreate,
} from '../domain/modelAutomationValidation.js';
import { isTerminalStatus } from '../domain/runTransitions.js';
import { DEFAULT_JOB_ATTEMPTS } from '../domain/validation.js';
import type { RequestMetadata } from '../http/requestMetadata.js';
import {
  findExecutionForRun,
  type AutomationExecutionRecord,
} from '../repositories/automationExecutionLookup.js';
import { writeAuditEvent } from '../repositories/auditRepository.js';
import {
  findAutomaticRetry,
  findAutomationExecution,
  findAutomationExecutionBoundary,
  findAutomationRule,
  hasAutomationOwnerAccess,
  insertAutomationEvent,
  insertAutomationExecution,
  listAutomationExecutions,
  listAutomationRules,
  lockAutomationRule,
  lockExpiredAutomationEvents,
  lockPendingAutomationEvents,
  lockRegistrationRules,
  measureRuleChain,
  resolveAutomationEvent,
  summarizeRuleAttempts,
  updateAutomationRuleOwner,
  type AutomationExecutionInsert,
  type PendingAutomationEvent,
} from '../repositories/modelAutomationRepository.js';
import { findServiceAccount } from '../repositories/serviceAccountRepository.js';
import {
  assertProjectReference,
  assertProjectReferences,
  findCodeVersion,
  findModelVersion,
  findRun,
} from '../repositories/registryRepository.js';
import {
  findSavedArtifact,
  validateCodeArtifacts,
} from '../repositories/runtimeArtifactRepository.js';
import { assertNoReservedRunTags } from '../domain/reservedRunTags.js';
import { requireProject } from './accessService.js';
import { auditActor, recordDenial, type AuditEventDraft } from './auditService.js';
import { enqueueAutomationFailure } from './automationFailureNotification.js';
import { notifyListener } from './eventListeners.js';
import type { JobService } from './jobService.js';
import type { RunService } from './runService.js';

// Generated names follow the same limit as user-created Run names.
const RUN_NAME_LIMIT = 200;

// Why a pending registration ended without running its rules; the codes are part of the API contract.
const UNSUCCESSFUL_SOURCE_ERRORS = {
  source_unsuccessful: 'source_run_unsuccessful: 学習Runが成功しなかったため起動しません',
  source_timeout:
    'source_run_timeout: 学習Runの成功を期限内に確認できなかったか、学習Runが削除されたため起動しません',
} as const;
type UnsuccessfulSourceState = keyof typeof UNSUCCESSFUL_SOURCE_ERRORS;

const OWNER_ACCESS_REVOKED_ERROR =
  'creator_access_revoked: ルールの実行者（所有者）の管理者権限が失効しています';

// A chain longer than this is far beyond inference → evaluation → report; the limit keeps a
// mistaken setup from fanning out an unbounded number of Jobs from one model registration.
export const MAX_AUTOMATION_CHAIN_DEPTH = 5;

/**
 * What started one execution of a rule. A first stage has no trigger Run; a chained stage receives
 * the upstream Run, its output DatasetVersions, and the first-stage execution of the pipeline.
 */
export interface AutomationTrigger {
  run: Pick<Run, 'id' | 'outputDatasetVersionIds'> | null;
  pipelineRootExecutionId: string | null;
  source: ModelAutomationExecution['source'];
  attempt: number;
  requestedBy: string | null;
}

/** Told about every new ModelVersion after the rules (hooks with trigger model_registered). */
export interface ModelRegistrationListener {
  readonly name: string;
  onModelRegistered(connection: Connection, model: ModelVersion): Promise<void>;
}

const AUTOMATIC_REGISTRATION: AutomationTrigger = {
  run: null,
  pipelineRootExecutionId: null,
  source: 'automatic',
  attempt: 1,
  requestedBy: null,
};

export class ModelAutomationService {
  private readonly database: Database;
  private readonly runs: RunService;
  private readonly jobs: JobService;
  // Links in automation.failed notifications point at the Web app.
  private readonly webOrigin: string;
  // Kept by reference: app.ts adds the hooks once they are built from this service's peers.
  private readonly registrationListeners: readonly ModelRegistrationListener[];
  constructor(options: {
    database: Database;
    runs: RunService;
    jobs: JobService;
    webOrigin: string;
    registrationListeners?: readonly ModelRegistrationListener[];
  }) {
    this.database = options.database;
    this.runs = options.runs;
    this.jobs = options.jobs;
    this.webOrigin = options.webOrigin;
    this.registrationListeners = options.registrationListeners ?? [];
  }

  async rules(principal: Principal, projectId: string): Promise<ModelAutomationRule[]> {
    await requireProject(this.database, principal, {
      projectId,
      role: 'viewer',
      scope: 'read',
    });
    return listAutomationRules(this.database, projectId);
  }

  async createRule(
    principal: Principal,
    projectId: string,
    input: ModelAutomationRuleCreate,
  ): Promise<ModelAutomationRule> {
    return transaction(this.database, async (connection) => {
      await this.requireRuleAdmin(connection, principal, projectId);
      // Rule tags are copied onto every Run the rule starts, so they obey the Run tag rule.
      assertNoReservedRunTags(input.tags);
      assertRuleTrigger(input);
      if (input.upstreamRuleId !== null)
        await this.assertUpstreamRule(connection, { projectId, ruleId: input.upstreamRuleId });
      await assertProjectReference(connection, {
        table: 'experiments',
        projectId,
        id: input.experimentId,
      });
      await assertProjectReferences(connection, {
        table: 'dataset_versions',
        projectId,
        ids: input.inputDatasetVersionIds,
      });
      const code = await findCodeVersion(connection, {
        projectId,
        id: input.codeVersionId,
      });
      for (const family of input.modelFamilies)
        validateCodeCompatibility(code, {
          model: { family },
          kind: input.kind,
        });
      await validateCodeArtifacts(connection, code);
      await this.jobs.validateTarget(connection, {
        targetId: input.targetId,
        gpuIds: input.gpuIds,
        runtime: code.runtime,
        usage: { projectId, userId: principal.user.id },
      });
      const created = (await first<{ id: string }>(
        connection,
        `INSERT INTO model_automation_rules(project_id,name,enabled,model_families,kind,experiment_id,code_version_id,target_id,gpu_ids,input_dataset_version_ids,parameters,tags,max_attempts,created_by,trigger,upstream_rule_id,summary_metrics,run_as_user_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$14) RETURNING id`,
        [
          projectId,
          input.name,
          input.enabled,
          input.modelFamilies,
          input.kind,
          input.experimentId,
          input.codeVersionId,
          input.targetId,
          input.gpuIds,
          input.inputDatasetVersionIds,
          JSON.stringify(input.parameters),
          JSON.stringify(input.tags),
          input.maxAttempts,
          principal.user.id,
          input.trigger,
          input.upstreamRuleId,
          input.summaryMetrics,
        ],
      ))!;
      return (await findAutomationRule(connection, { projectId, id: created.id }))!;
    });
  }

  // The upstream must be an enabled rule of the same Project, and the new rule must stay within
  // the chain depth limit.
  private async assertUpstreamRule(
    connection: Connection,
    upstream: { projectId: string; ruleId: string },
  ): Promise<void> {
    const rule = await lockAutomationRule(connection, {
      projectId: upstream.projectId,
      id: upstream.ruleId,
      mode: 'share',
    });
    if (!rule) notFound('ModelAutomationRule');
    if (!rule.enabled)
      throw new DomainError(422, '上流のルールが無効です', 'upstream_rule_disabled');
    const chain = await measureRuleChain(connection, {
      projectId: upstream.projectId,
      ruleId: upstream.ruleId,
      maxDepth: MAX_AUTOMATION_CHAIN_DEPTH,
    });
    if (chain.hasCycle)
      throw new DomainError(422, 'ルールの連鎖が循環しています', 'automation_chain_cycle');
    if (chain.depth + 1 > MAX_AUTOMATION_CHAIN_DEPTH)
      throw new DomainError(
        422,
        `ルールの連鎖は${MAX_AUTOMATION_CHAIN_DEPTH}段までです`,
        'automation_chain_too_deep',
      );
  }

  async toggleRule(
    principal: Principal,
    projectId: string,
    toggle: { ruleId: string; enabled: boolean },
  ): Promise<ModelAutomationRule> {
    return transaction(this.database, async (connection) => {
      await this.requireRuleAdmin(connection, principal, projectId);
      const toggled = await first(
        connection,
        'UPDATE model_automation_rules SET enabled=$3 WHERE id=$1 AND project_id=$2 RETURNING id',
        [toggle.ruleId, projectId, toggle.enabled],
      );
      if (!toggled) notFound('ModelAutomationRule');
      return (await findAutomationRule(connection, { projectId, id: toggle.ruleId }))!;
    });
  }

  /**
   * Moves the user a rule runs as to a Service Account of the same Project, so the rule keeps
   * running when its creator leaves. The account must be active and a Project admin, which is
   * what running a rule requires. created_by keeps the creator. Setting the same owner again
   * changes nothing and is not audited again.
   */
  async transferOwner(
    principal: Principal,
    projectId: string,
    transfer: { ruleId: string; input: AutomationRuleOwnerTransfer; metadata: RequestMetadata },
  ): Promise<ModelAutomationRule> {
    const draft: AuditEventDraft = {
      ...auditActor(principal),
      ...transfer.metadata,
      action: 'automation_rule.owner.transfer',
      resourceType: 'model_automation_rule',
      resourceId: transfer.ruleId,
      projectId,
      details: { serviceAccountId: transfer.input.serviceAccountId },
    };
    return recordDenial(this.database, draft, () =>
      transaction(this.database, async (connection) => {
        await this.requireRuleAdmin(connection, principal, projectId);
        const rule = await lockAutomationRule(connection, {
          projectId,
          id: transfer.ruleId,
          mode: 'update',
        });
        if (!rule) notFound('ModelAutomationRule');
        const serviceAccountId = transfer.input.serviceAccountId;
        const account = await findServiceAccount(connection, { projectId, serviceAccountId });
        if (!account || account.status !== 'active' || account.role !== 'admin')
          throw new DomainError(
            422,
            '移管先は同じプロジェクトの有効なService Account（role admin）にしてください',
            'invalid_automation_owner',
          );
        if (rule.runAsUserId !== serviceAccountId) {
          await updateAutomationRuleOwner(connection, {
            ruleId: rule.id,
            runAsUserId: serviceAccountId,
          });
          await writeAuditEvent(connection, {
            ...draft,
            outcome: 'success',
            details: { ...draft.details, previousRunAsUserId: rule.runAsUserId },
          });
        }
        return (await findAutomationRule(connection, { projectId, id: rule.id }))!;
      }),
    );
  }

  async executions(
    principal: Principal,
    projectId: string,
    query: AutomationExecutionQuery,
  ): Promise<ModelAutomationExecutionPage> {
    await requireProject(this.database, principal, {
      projectId,
      role: 'viewer',
      scope: 'read',
    });
    const filter = { projectId, modelVersionId: query.modelVersionId, ruleId: query.ruleId };
    const after = query.cursor
      ? await findAutomationExecutionBoundary(this.database, { ...filter, id: query.cursor })
      : undefined;
    if (query.cursor && !after) notFound('ModelAutomationExecution cursor');
    const page = await listAutomationExecutions(this.database, {
      ...filter,
      limit: query.limit + 1,
      after,
    });
    const items = page.slice(0, query.limit);
    return { items, nextCursor: page.length > query.limit ? items.at(-1)!.id : null };
  }

  async processRegistration(
    connection: Connection,
    reference: { projectId: string; modelVersionId: string },
  ): Promise<void> {
    const model = await findModelVersion(connection, {
      projectId: reference.projectId,
      id: reference.modelVersionId,
    });
    // registerModelVersion holds a key-share lock on the source Run, so its status cannot become terminal
    // until this transaction ends; a still-running Run may yet fail, so its versions wait for
    // AutomationSourceRunHandler instead of starting inference on unfinished training.
    const sourceRun = model.sourceRunId
      ? await findRun(connection, { projectId: model.projectId, id: model.sourceRunId })
      : null;
    const isPending = sourceRun !== null && !isTerminalStatus(sourceRun.status);
    const isNewEvent = await insertAutomationEvent(connection, {
      modelVersionId: model.id,
      projectId: model.projectId,
      sourceRunId: sourceRun?.id ?? null,
      isPending,
    });
    if (isNewEvent && !isPending) await this.executeEnabledRules(connection, model);
    // Listeners keep their own records of repeated and pending registrations.
    for (const listener of this.registrationListeners)
      await notifyListener(connection, {
        listener: listener.name,
        subjectId: model.id,
        notify: () => listener.onModelRegistered(connection, model),
      });
  }

  // The source Run finished: run the rules enabled at this moment for every version it registered.
  async releasePendingRegistrations(connection: Connection, sourceRunId: string): Promise<void> {
    for (const event of await lockPendingAutomationEvents(connection, sourceRunId)) {
      const model = await findModelVersion(connection, {
        projectId: event.projectId,
        id: event.modelVersionId,
      });
      await this.executeEnabledRules(connection, model);
      await resolveAutomationEvent(connection, {
        modelVersionId: event.modelVersionId,
        state: 'processed',
      });
    }
  }

  async skipPendingRegistrations(connection: Connection, sourceRunId: string): Promise<void> {
    await this.skipRegistrations(connection, {
      events: await lockPendingAutomationEvents(connection, sourceRunId),
      state: 'source_unsuccessful',
    });
  }

  // Returns the number of expired events so the sweeper can keep going while a backlog remains.
  async expirePendingRegistrations(
    connection: Connection,
    expiry: { maxAgeHours: number; limit: number },
  ): Promise<number> {
    const events = await lockExpiredAutomationEvents(connection, expiry);
    await this.skipRegistrations(connection, { events, state: 'source_timeout' });
    return events.length;
  }

  private async skipRegistrations(
    connection: Connection,
    resolution: { events: PendingAutomationEvent[]; state: UnsuccessfulSourceState },
  ): Promise<void> {
    for (const event of resolution.events) {
      const model = await findModelVersion(connection, {
        projectId: event.projectId,
        id: event.modelVersionId,
      });
      for (const rule of await lockRegistrationRules(connection, model)) {
        const execution = {
          id: randomUUID(),
          projectId: model.projectId,
          ruleId: rule.id,
          modelVersionId: model.id,
          status: 'skipped' as const,
          error: UNSUCCESSFUL_SOURCE_ERRORS[resolution.state],
        };
        // A failed source Run is announced as run.failed already; only the timeout is new news.
        if (resolution.state === 'source_timeout')
          await this.recordUnstarted(connection, { execution, rule, model });
        else await insertAutomationExecution(connection, execution);
      }
      await resolveAutomationEvent(connection, {
        modelVersionId: model.id,
        state: resolution.state,
      });
    }
  }

  private async executeEnabledRules(connection: Connection, model: ModelVersion): Promise<void> {
    for (const rule of await lockRegistrationRules(connection, model))
      await this.executeRule(connection, { rule, model, trigger: AUTOMATIC_REGISTRATION });
  }

  /**
   * Starts one rule for one version and records the outcome as an execution; shared by
   * registrations, chained stages, and manual applications. Failures are recorded, not thrown, so
   * the caller's other rules and the registration itself are kept. Returns the execution id.
   */
  async executeRule(
    connection: Connection,
    start: { rule: ModelAutomationRule; model: ModelVersion; trigger: AutomationTrigger },
  ): Promise<string> {
    const { rule, model, trigger } = start;
    const execution = {
      id: randomUUID(),
      projectId: model.projectId,
      ruleId: rule.id,
      modelVersionId: model.id,
      triggerRunId: trigger.run?.id ?? null,
      pipelineRootExecutionId: trigger.pipelineRootExecutionId,
      attempt: trigger.attempt,
      source: trigger.source,
      requestedBy: trigger.requestedBy,
    };
    if (!(await hasAutomationOwnerAccess(connection, rule))) {
      await this.recordUnstarted(connection, {
        execution: { ...execution, status: 'skipped', error: OWNER_ACCESS_REVOKED_ERROR },
        rule,
        model,
      });
      return execution.id;
    }
    if (!model.artifactId && !model.weightsUri) {
      await this.recordUnstarted(connection, {
        execution: {
          ...execution,
          status: 'skipped',
          error: 'weights_required: モデルの重みが指定されていません',
        },
        rule,
        model,
      });
      return execution.id;
    }
    const upstreamOutputIds = trigger.run?.outputDatasetVersionIds ?? [];
    await connection.query('SAVEPOINT automation_rule');
    try {
      if (model.artifactId)
        await findSavedArtifact(connection, {
          projectId: model.projectId,
          artifactId: model.artifactId,
        });
      const run = await this.runs.insertRun(connection, {
        projectId: model.projectId,
        createdBy: rule.runAsUserId,
        input: {
          experimentId: rule.experimentId,
          name: `${rule.name}: ${model.version}`.slice(0, RUN_NAME_LIMIT),
          kind: rule.kind,
          modelVersionId: model.id,
          codeVersionId: rule.codeVersionId,
          inputDatasetVersionIds: [
            ...new Set([...rule.inputDatasetVersionIds, ...upstreamOutputIds]),
          ],
          parameters: rule.parameters,
          tags: {
            ...rule.tags,
            'automation.ruleId': rule.id,
            ...(trigger.pipelineRootExecutionId
              ? { 'automation.pipelineRoot': trigger.pipelineRootExecutionId }
              : {}),
          },
          environment: { automationRuleId: rule.id },
          // A chained stage hangs under the upstream Run, which the worker hands to the container.
          parentRunId: trigger.run?.id ?? model.sourceRunId,
        },
        // Evaluation conditions are matched on the rule's fixed inputs only (the reference set).
        upstreamDatasetVersionIds: upstreamOutputIds,
      });
      const job = await this.jobs.insertJob(connection, {
        run,
        input: {
          runId: run.id,
          targetId: rule.targetId,
          gpuIds: rule.gpuIds,
          // A rule's maxAttempts bounds automatic attempts (1, the default, means no automatic
          // retry); people may still retry an automated Job by hand up to the usual Job limit.
          maxAttempts: Math.max(rule.maxAttempts, DEFAULT_JOB_ATTEMPTS),
        },
        attempt: 1,
      });
      await insertAutomationExecution(connection, {
        ...execution,
        runId: run.id,
        jobId: job.id,
        status: 'queued',
      });
    } catch (error) {
      await connection.query('ROLLBACK TO SAVEPOINT automation_rule');
      await this.recordUnstarted(connection, {
        execution: { ...execution, status: 'failed', error: automationFailureMessage(error) },
        rule,
        model,
      });
    }
    await connection.query('RELEASE SAVEPOINT automation_rule');
    return execution.id;
  }

  /**
   * Starts the next attempt of an automated Run that failed: a new execution that points at the
   * failed one, with a Run and Job made by the Job retry (retry_of_job_id). It runs as the rule's
   * current owner and never resumes from a checkpoint (resuming is a manual choice). Whether the
   * failure deserves a retry is the caller's decision. Returns the new execution id, or null
   * when the execution was already retried or its rule allows no further attempt.
   */
  async retryExecution(
    connection: Connection,
    failed: { execution: AutomationExecutionRecord; run: Run; job: Job },
  ): Promise<string | null> {
    const { execution, run, job } = failed;
    const rule = await lockAutomationRule(connection, {
      projectId: execution.projectId,
      id: execution.ruleId,
      mode: 'share',
    });
    // A disabled rule stops its pipeline, including the retries of Runs it started before.
    if (!rule?.enabled || execution.attempt >= rule.maxAttempts) return null;
    if (job.attempt >= job.maxAttempts) return null;
    if (await findAutomaticRetry(connection, execution.id)) return null;
    const model = await findModelVersion(connection, {
      projectId: execution.projectId,
      id: execution.modelVersionId,
    });
    const retry = {
      id: randomUUID(),
      projectId: execution.projectId,
      ruleId: rule.id,
      modelVersionId: model.id,
      triggerRunId: execution.triggerRunId,
      pipelineRootExecutionId: execution.pipelineRootExecutionId,
      attempt: execution.attempt + 1,
      source: 'automatic' as const,
      retryOfExecutionId: execution.id,
    };
    if (!(await hasAutomationOwnerAccess(connection, rule))) {
      await this.recordUnstarted(connection, {
        execution: { ...retry, status: 'skipped', error: OWNER_ACCESS_REVOKED_ERROR },
        rule,
        model,
      });
      return retry.id;
    }
    await connection.query('SAVEPOINT automation_retry');
    try {
      const next = await this.jobs.insertRetry(connection, {
        previousJob: job,
        previousRun: run,
        createdBy: rule.runAsUserId,
        checkpointId: null,
      });
      await insertAutomationExecution(connection, {
        ...retry,
        runId: next.run.id,
        jobId: next.job.id,
        status: 'queued',
      });
    } catch (error) {
      await connection.query('ROLLBACK TO SAVEPOINT automation_retry');
      await this.recordUnstarted(connection, {
        execution: { ...retry, status: 'failed', error: automationFailureMessage(error) },
        rule,
        model,
      });
    }
    await connection.query('RELEASE SAVEPOINT automation_retry');
    return retry.id;
  }

  // An execution that did not start a Run is stored and announced as automation.failed.
  private async recordUnstarted(
    connection: Connection,
    unstarted: {
      execution: AutomationExecutionInsert & {
        id: string;
        status: 'failed' | 'skipped';
        error: string;
      };
      rule: ModelAutomationRule;
      model: ModelVersion;
    },
  ): Promise<void> {
    const { execution } = unstarted;
    await insertAutomationExecution(connection, execution);
    await enqueueAutomationFailure(connection, {
      executionId: execution.id,
      rule: unstarted.rule,
      model: unstarted.model,
      status: execution.status,
      error: execution.error,
      webOrigin: this.webOrigin,
    });
  }

  /**
   * Applies a rule by hand to an existing version (registration rules) or to a finished upstream
   * Run (chained rules), for example after fixing evaluation code in a new rule. Only Project
   * admins may do this; the run is recorded as a new attempt with source 'manual'.
   */
  async applyRule(
    principal: Principal,
    projectId: string,
    application: { ruleId: string; input: AutomationExecutionCreate; metadata: RequestMetadata },
  ): Promise<ModelAutomationExecution> {
    const draft: AuditEventDraft = {
      ...auditActor(principal),
      ...application.metadata,
      action: 'automation.execution.manual',
      resourceType: 'model_automation_rule',
      resourceId: application.ruleId,
      projectId,
      details: { ...application.input },
    };
    return recordDenial(this.database, draft, () =>
      transaction(this.database, async (connection) => {
        await this.requireRuleAdmin(connection, principal, projectId);
        const rule = await lockAutomationRule(connection, {
          projectId,
          id: application.ruleId,
          mode: 'update',
        });
        if (!rule) notFound('ModelAutomationRule');
        if (!rule.enabled)
          throw new DomainError(422, '無効なルールは適用できません', 'automation_rule_disabled');
        const target = await this.resolveManualTarget(connection, { rule, input: application.input });
        if (!rule.modelFamilies.includes(target.model.family))
          throw new DomainError(
            422,
            `ルールの対象にモデル系列${target.model.family}が含まれていません`,
            'incompatible_model_family',
          );
        const attempts = await summarizeRuleAttempts(connection, {
          ruleId: rule.id,
          modelVersionId: target.model.id,
        });
        if (attempts.hasActive)
          throw new DomainError(
            409,
            '同じルールとモデル版の実行が待機中または実行中です',
            'automation_execution_active',
          );
        const executionId = await this.executeRule(connection, {
          rule,
          model: target.model,
          trigger: {
            run: target.triggerRun,
            pipelineRootExecutionId: target.pipelineRootExecutionId,
            source: 'manual',
            attempt: attempts.maxAttempt + 1,
            requestedBy: principal.user.id,
          },
        });
        const execution = (await findAutomationExecution(connection, {
          projectId,
          id: executionId,
        }))!;
        await writeAuditEvent(connection, {
          ...draft,
          outcome: 'success',
          details: {
            ...draft.details,
            executionId,
            modelVersionId: target.model.id,
            attempt: execution.attempt,
            status: execution.status,
          },
        });
        return execution;
      }),
    );
  }

  private async resolveManualTarget(
    connection: Connection,
    request: { rule: ModelAutomationRule; input: AutomationExecutionCreate },
  ): Promise<{
    model: ModelVersion;
    triggerRun: Run | null;
    pipelineRootExecutionId: string | null;
  }> {
    const { rule, input } = request;
    if ('modelVersionId' in input) {
      if (rule.trigger !== 'model_registered')
        throw new DomainError(
          422,
          '連鎖するルールには上流RunのID（triggerRunId）を指定します',
          'automation_trigger_mismatch',
        );
      const model = await findModelVersion(connection, {
        projectId: rule.projectId,
        id: input.modelVersionId,
      });
      return { model, triggerRun: null, pipelineRootExecutionId: null };
    }
    if (rule.trigger !== 'upstream_run_finished')
      throw new DomainError(
        422,
        'モデル登録で起動するルールにはモデル版のID（modelVersionId）を指定します',
        'automation_trigger_mismatch',
      );
    const run = await findRun(connection, { projectId: rule.projectId, id: input.triggerRunId });
    if (run.status !== 'finished')
      throw new DomainError(422, '上流Runが成功していません', 'upstream_run_not_finished');
    const upstream = await findExecutionForRun(connection, {
      projectId: rule.projectId,
      runId: run.id,
    });
    if (!upstream || upstream.ruleId !== rule.upstreamRuleId)
      throw new DomainError(
        422,
        '指定したRunはこのルールの上流ルールが作ったRunではありません',
        'upstream_rule_mismatch',
      );
    if (run.outputDatasetVersionIds.length === 0)
      throw new DomainError(
        422,
        '上流Runに出力DatasetVersionがありません',
        'upstream_outputs_missing',
      );
    const model = await findModelVersion(connection, {
      projectId: rule.projectId,
      id: upstream.modelVersionId,
    });
    return { model, triggerRun: run, pipelineRootExecutionId: upstream.pipelineRootExecutionId };
  }

  private async requireRuleAdmin(
    connection: Connection,
    principal: Principal,
    projectId: string,
  ): Promise<void> {
    // Global administrators still obey token scope, project restrictions, and current token membership.
    await requireProject(connection, principal, {
      projectId,
      role: principal.user.isAdmin ? 'viewer' : 'admin',
      scope: 'admin',
    });
  }
}
