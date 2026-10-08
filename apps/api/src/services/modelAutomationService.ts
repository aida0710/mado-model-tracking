import type { ModelAutomationExecution, ModelAutomationRule, ModelVersion } from '@mmt/contracts';
import type { Principal } from '../auth/principal.js';
import { first, rows, transaction, type Connection, type Database } from '../db/database.js';
import { automationFailureMessage } from '../domain/automationFailure.js';
import { validateCodeCompatibility } from '../domain/compatibility.js';
import { notFound } from '../domain/errors.js';
import type { ModelAutomationRuleCreate } from '../domain/modelAutomationValidation.js';
import { isTerminalStatus } from '../domain/runTransitions.js';
import {
  hasAutomationCreatorAccess,
  insertAutomationEvent,
  insertAutomationExecution,
  listAutomationExecutions,
  lockExpiredAutomationEvents,
  lockPendingAutomationEvents,
  resolveAutomationEvent,
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
        `INSERT INTO model_automation_rules(project_id,name,enabled,model_families,kind,experiment_id,code_version_id,target_id,gpu_ids,input_dataset_version_ids,parameters,tags,max_attempts,created_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
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
        ],
      ))!;
    });
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
      for (const rule of await this.lockEnabledRules(connection, model))
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
    for (const rule of await this.lockEnabledRules(connection, model))
      await this.executeRule(connection, { rule, model });
  }

  // FOR SHARE makes a concurrent enable/disable wait, so the rule set is the one at this moment.
  private async lockEnabledRules(
    connection: Connection,
    model: ModelVersion,
  ): Promise<ModelAutomationRule[]> {
    return rows<ModelAutomationRule>(
      connection,
      `SELECT * FROM model_automation_rules WHERE project_id=$1 AND enabled AND $2=ANY(model_families)
      ORDER BY created_at,id FOR SHARE`,
      [model.projectId, model.family],
    );
  }

  private async executeRule(
    connection: Connection,
    registration: { rule: ModelAutomationRule; model: ModelVersion },
  ): Promise<void> {
    const { rule, model } = registration;
    const execution = {
      projectId: model.projectId,
      ruleId: rule.id,
      modelVersionId: model.id,
    };
    if (!(await hasAutomationCreatorAccess(connection, rule))) {
      await insertAutomationExecution(connection, {
        ...execution,
        status: 'skipped',
        error: 'creator_access_revoked: ルール作成者の管理者権限が失効しています',
      });
      return;
    }
    if (!model.artifactId && !model.weightsUri) {
      await insertAutomationExecution(connection, {
        ...execution,
        status: 'skipped',
        error: 'weights_required: モデルの重みが指定されていません',
      });
      return;
    }
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
          inputDatasetVersionIds: rule.inputDatasetVersionIds,
          parameters: rule.parameters,
          tags: { ...rule.tags, 'automation.ruleId': rule.id },
          environment: { automationRuleId: rule.id },
          parentRunId: model.sourceRunId,
        },
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
