import { randomUUID } from 'node:crypto';
import type {
  ModelAutomationExecution,
  ModelAutomationRule,
  ModelVersion,
  Run,
} from '@mmt/contracts';
import type { Principal } from '../auth/principal.js';
import { first, rows, transaction, type Connection, type Database } from '../db/database.js';
import { automationFailureMessage } from '../domain/automationFailure.js';
import { validateCodeCompatibility } from '../domain/compatibility.js';
import { DomainError, notFound } from '../domain/errors.js';
import {
  assertRuleTrigger,
  type AutomationExecutionCreate,
  type ModelAutomationRuleCreate,
} from '../domain/modelAutomationValidation.js';
import { isTerminalStatus } from '../domain/runTransitions.js';
import type { RequestMetadata } from '../http/requestMetadata.js';
import { findExecutionForRun } from '../repositories/automationExecutionLookup.js';
import { writeAuditEvent } from '../repositories/auditRepository.js';
import {
  findAutomationExecution,
  hasAutomationCreatorAccess,
  insertAutomationEvent,
  insertAutomationExecution,
  listAutomationExecutions,
  lockAutomationRule,
  lockExpiredAutomationEvents,
  lockPendingAutomationEvents,
  lockRegistrationRules,
  measureRuleChain,
  resolveAutomationEvent,
  summarizeRuleAttempts,
  type PendingAutomationEvent,
} from '../repositories/modelAutomationRepository.js';
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
import type { JobService } from './jobService.js';
import type { RunService } from './runService.js';

// A bounded history supports the Models screen without loading an entire project.
const AUTOMATION_EXECUTION_LIMIT = 100;
// Generated names follow the same limit as user-created Run names.
const RUN_NAME_LIMIT = 200;

// Why a pending registration ended without running its rules; the codes are part of the API contract.
const UNSUCCESSFUL_SOURCE_ERRORS = {
  source_unsuccessful: 'source_run_unsuccessful: 学習Runが成功しなかったため起動しません',
  source_timeout:
    'source_run_timeout: 学習Runの成功を期限内に確認できなかったか、学習Runが削除されたため起動しません',
} as const;
type UnsuccessfulSourceState = keyof typeof UNSUCCESSFUL_SOURCE_ERRORS;

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

const AUTOMATIC_REGISTRATION: AutomationTrigger = {
  run: null,
  pipelineRootExecutionId: null,
  source: 'automatic',
  attempt: 1,
  requestedBy: null,
};

export class ModelAutomationService {
  constructor(
    private readonly database: Database,
    private readonly runs: RunService,
    private readonly jobs: JobService,
  ) {}

  async rules(principal: Principal, projectId: string): Promise<ModelAutomationRule[]> {
    await requireProject(this.database, principal, {
      projectId,
      role: 'viewer',
      scope: 'read',
    });
    return rows(
      this.database,
      'SELECT * FROM model_automation_rules WHERE project_id=$1 ORDER BY created_at DESC,id DESC',
      [projectId],
    );
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
      });
      return (await first<ModelAutomationRule>(
        connection,
        `INSERT INTO model_automation_rules(project_id,name,enabled,model_families,kind,experiment_id,code_version_id,target_id,gpu_ids,input_dataset_version_ids,parameters,tags,max_attempts,created_by,trigger,upstream_rule_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
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
        ],
      ))!;
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
      const rule = await first<ModelAutomationRule>(
        connection,
        'UPDATE model_automation_rules SET enabled=$3 WHERE id=$1 AND project_id=$2 RETURNING *',
        [toggle.ruleId, projectId, toggle.enabled],
      );
      if (!rule) notFound('ModelAutomationRule');
      return rule;
    });
  }

  async executions(principal: Principal, projectId: string): Promise<ModelAutomationExecution[]> {
    await requireProject(this.database, principal, {
      projectId,
      role: 'viewer',
      scope: 'read',
    });
    return listAutomationExecutions(this.database, {
      projectId,
      limit: AUTOMATION_EXECUTION_LIMIT,
    });
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
    if (!isNewEvent || isPending) return;
    await this.executeEnabledRules(connection, model);
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
      for (const rule of await lockRegistrationRules(connection, model))
        await insertAutomationExecution(connection, {
          projectId: model.projectId,
          ruleId: rule.id,
          modelVersionId: model.id,
          status: 'skipped',
          error: UNSUCCESSFUL_SOURCE_ERRORS[resolution.state],
        });
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
    if (!(await hasAutomationCreatorAccess(connection, rule))) {
      await insertAutomationExecution(connection, {
        ...execution,
        status: 'skipped',
        error: 'creator_access_revoked: ルール作成者の管理者権限が失効しています',
      });
      return execution.id;
    }
    if (!model.artifactId && !model.weightsUri) {
      await insertAutomationExecution(connection, {
        ...execution,
        status: 'skipped',
        error: 'weights_required: モデルの重みが指定されていません',
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
        createdBy: rule.createdBy,
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
          maxAttempts: rule.maxAttempts,
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
      await insertAutomationExecution(connection, {
        ...execution,
        status: 'failed',
        error: automationFailureMessage(error),
      });
    }
    await connection.query('RELEASE SAVEPOINT automation_rule');
    return execution.id;
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
