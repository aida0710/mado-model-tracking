import type {
  PromotionEvaluation,
  PromotionEvaluationPage,
  PromotionPolicy,
  Run,
} from '@mmt/contracts';
import type { Principal } from '../auth/principal.js';
import { transaction, type Connection, type Database } from '../db/database.js';
import { conflict, DomainError, notFound } from '../domain/errors.js';
import { evaluateCriteria } from '../domain/promotionCriteria.js';
import type {
  PromotionEvaluationQuery,
  PromotionPolicyInput,
  PromotionPolicyQuery,
} from '../domain/promotionPolicyValidation.js';
import type { RequestMetadata } from '../http/requestMetadata.js';
import { writeAuditEvent } from '../repositories/auditRepository.js';
import { findExecutionForRun } from '../repositories/automationExecutionLookup.js';
import {
  findActiveModelFamily,
  findEvaluationRule,
  findModelIdOfVersion,
  findPromotionEvaluation,
  hasPromotionCreatorAccess,
  hasPromotionEvaluation,
  insertPromotionEvaluation,
  insertPromotionPolicy,
  listPromotionEvaluations,
  listPromotionPolicies,
  lockEnabledPoliciesForRule,
  lockNextEvaluationSequence,
  lockPromotionPolicy,
  promotionEvaluationCursorExists,
  setPromotionPolicyEnabled,
  type PromotionEvaluationRecord,
  type PromotionEvaluationRule,
} from '../repositories/promotionRepository.js';
import { requireProject } from './accessService.js';
import { auditActor, NO_REQUEST_METADATA, recordDenial, type AuditEventDraft } from './auditService.js';
import { compareToBaselineInternal } from './evaluationService.js';

const POLICY_SAVEPOINT = 'promotion_policy';

type Judgement = Pick<
  PromotionEvaluationRecord,
  'baselineVersionId' | 'baselineRunId' | 'decision' | 'criteriaResults' | 'reason'
>;

function skippedJudgement(reason: 'creator_access_revoked' | 'evaluation_error'): Judgement {
  return {
    baselineVersionId: null,
    baselineRunId: null,
    decision: 'skipped',
    criteriaResults: [],
    reason,
  };
}

/**
 * Compares the candidate Run with the baseline under the policy's rule. Both sides are limited to
 * Runs the rule's automation produced, and the conditions are the rule's fixed reference set and
 * evaluation CodeVersion, so a hand-made evaluation Run can neither be judged nor serve as baseline.
 */
async function judgeCandidate(
  connection: Connection,
  judged: {
    policy: PromotionPolicy;
    rule: PromotionEvaluationRule;
    candidate: { versionId: string; runId: string };
  },
): Promise<Judgement> {
  const { policy, rule, candidate } = judged;
  const comparison = await compareToBaselineInternal(connection, policy.projectId, {
    modelId: policy.modelId,
    candidateVersionId: candidate.versionId,
    candidateRunId: candidate.runId,
    baselineAlias: policy.baselineAlias,
    referenceDatasetVersionIds: rule.inputDatasetVersionIds,
    codeVersionId: rule.codeVersionId,
    evaluationRuleId: policy.evaluationRuleId,
    metrics: [...new Set(policy.criteria.map((criterion) => criterion.metric))],
  });
  return {
    baselineVersionId: comparison.baselineVersionId,
    baselineRunId: comparison.baselineRunId,
    ...evaluateCriteria(comparison, policy.criteria, policy.missingBaseline),
  };
}

export class PromotionService {
  constructor(private readonly database: Database) {}

  async policies(
    principal: Principal,
    projectId: string,
    query: PromotionPolicyQuery,
  ): Promise<PromotionPolicy[]> {
    await requireProject(this.database, principal, { projectId, role: 'viewer', scope: 'read' });
    return listPromotionPolicies(this.database, { projectId, modelId: query.modelId });
  }

  async createPolicy(
    principal: Principal,
    projectId: string,
    input: PromotionPolicyInput,
    request: RequestMetadata = NO_REQUEST_METADATA,
  ): Promise<PromotionPolicy> {
    const draft = this.policyDraft(principal, {
      action: 'promotion.policy.create',
      projectId,
      resourceId: null,
      request,
    });
    return recordDenial(this.database, draft, () =>
      transaction(this.database, async (connection) => {
        await this.requirePolicyAdmin(connection, principal, projectId);
        await this.validatePolicyReferences(connection, { projectId, input });
        const policy = await insertPromotionPolicy(connection, {
          projectId,
          input,
          createdBy: principal.user.id,
        });
        await writeAuditEvent(connection, {
          ...draft,
          outcome: 'success',
          resourceId: policy.id,
          details: {
            name: policy.name,
            modelId: policy.modelId,
            evaluationRuleId: policy.evaluationRuleId,
            targetAlias: policy.targetAlias,
            baselineAlias: policy.baselineAlias,
            autoPromote: policy.autoPromote,
          },
        });
        return policy;
      }),
    );
  }

  async setPolicyEnabled(
    principal: Principal,
    change: { projectId: string; policyId: string; enabled: boolean },
    request: RequestMetadata = NO_REQUEST_METADATA,
  ): Promise<PromotionPolicy> {
    const { projectId, policyId, enabled } = change;
    const draft = this.policyDraft(principal, {
      action: 'promotion.policy.update',
      projectId,
      resourceId: policyId,
      request,
    });
    return recordDenial(this.database, { ...draft, details: { enabled } }, () =>
      transaction(this.database, async (connection) => {
        await this.requirePolicyAdmin(connection, principal, projectId);
        const policy = await setPromotionPolicyEnabled(connection, {
          projectId,
          id: policyId,
          enabled,
        });
        if (!policy) notFound('PromotionPolicy');
        await writeAuditEvent(connection, { ...draft, outcome: 'success', details: { enabled } });
        return policy;
      }),
    );
  }

  async evaluations(
    principal: Principal,
    projectId: string,
    query: PromotionEvaluationQuery,
  ): Promise<PromotionEvaluationPage> {
    await requireProject(this.database, principal, { projectId, role: 'viewer', scope: 'read' });
    if (
      query.cursor &&
      !(await promotionEvaluationCursorExists(this.database, { projectId, id: query.cursor }))
    )
      notFound('PromotionEvaluation cursor');
    // Fetch one extra row to know whether another page exists without a count query.
    const items = await listPromotionEvaluations(this.database, {
      ...query,
      projectId,
      limit: query.limit + 1,
    });
    const page = items.slice(0, query.limit);
    return { items: page, nextCursor: items.length > query.limit ? page.at(-1)!.id : null };
  }

  /**
   * Judges the same candidate Run again under the same policy and appends the result as the next
   * sequence. The requester's current Project admin authority stands in for the policy creator's.
   */
  async reevaluate(
    principal: Principal,
    reference: { projectId: string; evaluationId: string },
    request: RequestMetadata = NO_REQUEST_METADATA,
  ): Promise<PromotionEvaluation> {
    const { projectId, evaluationId } = reference;
    const draft: AuditEventDraft = {
      ...auditActor(principal),
      ...request,
      action: 'promotion.evaluation.reevaluate',
      resourceType: 'promotion_evaluation',
      resourceId: evaluationId,
      projectId,
    };
    return recordDenial(this.database, draft, () =>
      transaction(this.database, async (connection) => {
        await this.requirePolicyAdmin(connection, principal, projectId);
        const previous = await findPromotionEvaluation(connection, { projectId, id: evaluationId });
        if (!previous) notFound('PromotionEvaluation');
        const policy = (await lockPromotionPolicy(connection, {
          projectId,
          id: previous.policyId,
        }))!;
        const rule = (await findEvaluationRule(connection, {
          projectId,
          id: policy.evaluationRuleId,
        }))!;
        const sequence = await lockNextEvaluationSequence(connection, {
          policyId: policy.id,
          candidateRunId: previous.candidateRunId,
        });
        const judgement = await judgeCandidate(connection, {
          policy,
          rule,
          candidate: { versionId: previous.candidateVersionId, runId: previous.candidateRunId },
        });
        const id = await insertPromotionEvaluation(connection, {
          projectId,
          policyId: policy.id,
          candidateVersionId: previous.candidateVersionId,
          candidateRunId: previous.candidateRunId,
          ...judgement,
          sequence,
          requestedBy: principal.user.id,
        });
        if (!id) conflict('同じ判定が同時に再実行されました');
        await writeAuditEvent(connection, {
          ...draft,
          outcome: 'success',
          details: {
            policyId: policy.id,
            candidateRunId: previous.candidateRunId,
            previousEvaluationId: previous.id,
            evaluationId: id,
            sequence,
            decision: judgement.decision,
          },
        });
        return (await findPromotionEvaluation(connection, { projectId, id }))!;
      }),
    );
  }

  /**
   * Called inside the transaction that moved an evaluation Run to finished. Only Runs produced by an
   * automation rule (including manual retries of its Jobs) are judged, by the enabled policies of
   * that rule and the Run's Model. Each policy's failure is recorded as skipped and never thrown, so
   * the Run's terminal status and outbox event commit regardless. A Run already judged by a policy
   * (an MLflow Run reopened and finished again) is not judged again; re-evaluation is explicit.
   */
  async processFinishedRun(connection: Connection, run: Run): Promise<void> {
    if (run.kind !== 'evaluation' || run.status !== 'finished' || !run.modelVersionId) return;
    const { projectId } = run;
    const execution = await findExecutionForRun(connection, { projectId, runId: run.id });
    if (!execution) return;
    const modelId = await findModelIdOfVersion(connection, {
      projectId,
      versionId: run.modelVersionId,
    });
    if (!modelId) return;
    const policies = await lockEnabledPoliciesForRule(connection, {
      projectId,
      evaluationRuleId: execution.ruleId,
      modelId,
    });
    if (!policies.length) return;
    const rule = (await findEvaluationRule(connection, { projectId, id: execution.ruleId }))!;
    for (const policy of policies)
      await this.judgeFinishedRun(connection, {
        policy,
        rule,
        candidate: { versionId: run.modelVersionId, runId: run.id },
      });
  }

  private async judgeFinishedRun(
    connection: Connection,
    judged: {
      policy: PromotionPolicy;
      rule: PromotionEvaluationRule;
      candidate: { versionId: string; runId: string };
    },
  ): Promise<void> {
    const { policy, candidate } = judged;
    const reference = { policyId: policy.id, candidateRunId: candidate.runId };
    if (await hasPromotionEvaluation(connection, reference)) return;
    await connection.query(`SAVEPOINT ${POLICY_SAVEPOINT}`);
    let judgement: Judgement;
    try {
      judgement = (await hasPromotionCreatorAccess(connection, policy))
        ? await judgeCandidate(connection, judged)
        : skippedJudgement('creator_access_revoked');
    } catch (error) {
      await connection.query(`ROLLBACK TO SAVEPOINT ${POLICY_SAVEPOINT}`);
      console.error(
        JSON.stringify({
          event: 'promotion_evaluation_failed',
          policyId: policy.id,
          runId: candidate.runId,
          message: error instanceof Error ? error.message : String(error),
        }),
      );
      judgement = skippedJudgement('evaluation_error');
    }
    await connection.query(`RELEASE SAVEPOINT ${POLICY_SAVEPOINT}`);
    await insertPromotionEvaluation(connection, {
      projectId: policy.projectId,
      policyId: policy.id,
      candidateVersionId: candidate.versionId,
      candidateRunId: candidate.runId,
      ...judgement,
      sequence: 1,
      requestedBy: null,
    });
  }

  private async validatePolicyReferences(
    connection: Connection,
    policy: { projectId: string; input: PromotionPolicyInput },
  ): Promise<void> {
    const { projectId, input } = policy;
    const family = await findActiveModelFamily(connection, { projectId, id: input.modelId });
    if (!family) notFound('Model');
    const rule = await findEvaluationRule(connection, { projectId, id: input.evaluationRuleId });
    if (!rule) notFound('ModelAutomationRule');
    if (rule.kind !== 'evaluation')
      throw new DomainError(
        422,
        '評価ruleにはkind=evaluationの自動実行ruleを指定してください',
        'promotion_rule_not_evaluation',
      );
    // A rule that never runs for this Model's family would leave the policy without candidates.
    if (!rule.modelFamilies.includes(family))
      throw new DomainError(
        422,
        '評価ruleの対象系列にModelの系列が含まれていません',
        'promotion_rule_family_mismatch',
      );
  }

  private policyDraft(
    principal: Principal,
    change: {
      action: string;
      projectId: string;
      resourceId: string | null;
      request: RequestMetadata;
    },
  ): AuditEventDraft {
    return {
      ...auditActor(principal),
      ...change.request,
      action: change.action,
      resourceType: 'promotion_policy',
      resourceId: change.resourceId,
      projectId: change.projectId,
    };
  }

  // Same rule as automation rules: Project admin or global administrator, admin scope for tokens.
  private async requirePolicyAdmin(
    connection: Connection,
    principal: Principal,
    projectId: string,
  ): Promise<void> {
    await requireProject(connection, principal, {
      projectId,
      role: principal.user.isAdmin ? 'viewer' : 'admin',
      scope: 'admin',
    });
  }
}
