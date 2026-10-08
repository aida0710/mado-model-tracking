import { randomUUID } from 'node:crypto';
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
import { MAX_MODEL_ALIAS_REASON_LENGTH } from '../domain/modelAliasValidation.js';
import { describeCriterionResult } from '../domain/promotionReasonText.js';
import type {
  PromotionEvaluationQuery,
  PromotionPolicyInput,
  PromotionPolicyQuery,
} from '../domain/promotionPolicyValidation.js';
import type { RequestMetadata } from '../http/requestMetadata.js';
import { writeAuditEvent } from '../repositories/auditRepository.js';
import { findExecutionForRun } from '../repositories/automationExecutionLookup.js';
import {
  assignModelAlias,
  findModelAliasVersion,
  lockModelAliases,
} from '../repositories/modelAliasRepository.js';
import { findServiceAccount } from '../repositories/serviceAccountRepository.js';
import {
  findActiveModelFamily,
  findEvaluationRule,
  findModelIdOfVersion,
  findPromotionEvaluation,
  hasPromotionEvaluation,
  hasPromotionRunAsAccess,
  insertPromotionEvaluation,
  insertPromotionPolicy,
  listPromotionEvaluations,
  listPromotionPolicies,
  lockEnabledPoliciesForRule,
  lockNextEvaluationSequence,
  lockPromotionPolicy,
  lockPromotionPolicyForUpdate,
  promotionEvaluationCursorExists,
  setPromotionPolicyEnabled,
  setPromotionPolicyRunAsUser,
  type PromotionEvaluationRecord,
  type PromotionEvaluationRule,
} from '../repositories/promotionRepository.js';
import { requireProject } from './accessService.js';
import { promotionAliasGuard } from './aliasProtectionService.js';
import { auditActor, NO_REQUEST_METADATA, recordDenial, type AuditEventDraft } from './auditService.js';
import { compareToBaselineInternal } from './evaluationService.js';

const POLICY_SAVEPOINT = 'promotion_policy';
const AUTO_PROMOTION_SAVEPOINT = 'promotion_alias';

type Judgement = Pick<
  PromotionEvaluationRecord,
  'baselineVersionId' | 'baselineRunId' | 'decision' | 'criteriaResults' | 'reason'
>;

function logPromotionFailure(
  event: 'promotion_evaluation_failed' | 'automatic_promotion_failed',
  failure: { policy: PromotionPolicy; candidate: { runId: string }; error: unknown },
): void {
  console.error(
    JSON.stringify({
      event,
      policyId: failure.policy.id,
      runId: failure.candidate.runId,
      message: failure.error instanceof Error ? failure.error.message : String(failure.error),
    }),
  );
}

function skippedJudgement(reason: 'creator_access_revoked' | 'evaluation_error'): Judgement {
  return {
    baselineVersionId: null,
    baselineRunId: null,
    decision: 'skipped',
    criteriaResults: [],
    reason,
  };
}

// The alias versions an automatic promotion must still find under the Model lock.
interface PromotionAliasSnapshot {
  baselineVersionId: string | null;
  targetVersionId: string | null;
}

async function readPromotionAliases(
  connection: Connection,
  policy: PromotionPolicy,
): Promise<PromotionAliasSnapshot> {
  const baselineVersionId = await findModelAliasVersion(connection, {
    modelId: policy.modelId,
    alias: policy.baselineAlias,
  });
  const targetVersionId =
    policy.targetAlias === policy.baselineAlias
      ? baselineVersionId
      : await findModelAliasVersion(connection, {
          modelId: policy.modelId,
          alias: policy.targetAlias,
        });
  return { baselineVersionId, targetVersionId };
}

/** The alias event's reason: which policy passed the version and on what numbers. */
function automaticPromotionReason(policy: PromotionPolicy, judgement: Judgement): string {
  const firstRelease = judgement.reason === 'baseline_missing_first_promotion' ? '（基準版なし）' : '';
  const reason = `昇格policy「${policy.name}」の合格判定による自動昇格${firstRelease}: ${judgement.criteriaResults
    .map(describeCriterionResult)
    .join(', ')}`;
  return reason.slice(0, MAX_MODEL_ALIAS_REASON_LENGTH);
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

  /**
   * Makes the policy act as a Service Account of the Project, so judgements and automatic
   * promotions go on after the human owner leaves. The account must be active and hold the admin
   * role, the authority every judgement re-checks. Naming the current owner again changes nothing.
   */
  async transferPolicyOwner(
    principal: Principal,
    change: { projectId: string; policyId: string; serviceAccountId: string },
    request: RequestMetadata = NO_REQUEST_METADATA,
  ): Promise<PromotionPolicy> {
    const { projectId, policyId, serviceAccountId } = change;
    const draft = this.policyDraft(principal, {
      action: 'promotion_policy.owner.transfer',
      projectId,
      resourceId: policyId,
      request,
    });
    return recordDenial(this.database, { ...draft, details: { serviceAccountId } }, () =>
      transaction(this.database, async (connection) => {
        await this.requirePolicyAdmin(connection, principal, projectId);
        const policy = await lockPromotionPolicyForUpdate(connection, { projectId, id: policyId });
        if (!policy) notFound('PromotionPolicy');
        const account = await findServiceAccount(connection, { projectId, serviceAccountId });
        if (!account || account.status !== 'active' || account.role !== 'admin')
          throw new DomainError(
            422,
            '移管先には、このProjectの有効なService Account（roleがadmin）を指定してください',
            'promotion_owner_invalid',
          );
        if (policy.runAsUserId === account.id) return policy;
        const updated = await setPromotionPolicyRunAsUser(connection, {
          projectId,
          id: policyId,
          runAsUserId: account.id,
        });
        await writeAuditEvent(connection, {
          ...draft,
          outcome: 'success',
          details: { previousRunAsUserId: policy.runAsUserId, runAsUserId: account.id },
        });
        return updated;
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
   * sequence. The requester's current Project admin authority stands in for the run-as user's.
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
   * A pass of an autoPromote policy also moves its targetAlias (recordWithAutomaticPromotion).
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
    // Read before judging: a manual change committed after this point must stop the promotion.
    const aliasesAtJudgement = policy.autoPromote
      ? await readPromotionAliases(connection, policy)
      : null;
    await connection.query(`SAVEPOINT ${POLICY_SAVEPOINT}`);
    let judgement: Judgement;
    try {
      judgement = (await hasPromotionRunAsAccess(connection, policy))
        ? await judgeCandidate(connection, judged)
        : skippedJudgement('creator_access_revoked');
    } catch (error) {
      await connection.query(`ROLLBACK TO SAVEPOINT ${POLICY_SAVEPOINT}`);
      logPromotionFailure('promotion_evaluation_failed', { policy, candidate, error });
      judgement = skippedJudgement('evaluation_error');
    }
    await connection.query(`RELEASE SAVEPOINT ${POLICY_SAVEPOINT}`);
    const record: PromotionEvaluationRecord = {
      projectId: policy.projectId,
      policyId: policy.id,
      candidateVersionId: candidate.versionId,
      candidateRunId: candidate.runId,
      ...judgement,
      sequence: 1,
      requestedBy: null,
    };
    if (aliasesAtJudgement && judgement.decision === 'passed')
      await this.recordWithAutomaticPromotion(connection, {
        policy,
        record,
        judgement,
        aliasesAtJudgement,
      });
    else await insertPromotionEvaluation(connection, record);
  }

  /**
   * Moves targetAlias to the passed candidate and records the decision with the alias event, in
   * one savepoint. Under the Model lock the baseline and target aliases must still point where the
   * judgement found them; a concurrent manual change wins and the decision records
   * baseline_changed. A candidate that already holds targetAlias changes nothing. A refused change
   * (the run-as user's authority under alias protections) records promotion_denied. Only automatic
   * decisions promote; a re-evaluation leaves the alias to a person (PromotionDialog).
   */
  private async recordWithAutomaticPromotion(
    connection: Connection,
    promotion: {
      policy: PromotionPolicy;
      record: PromotionEvaluationRecord;
      judgement: Judgement;
      aliasesAtJudgement: PromotionAliasSnapshot;
    },
  ): Promise<void> {
    const { policy, record, judgement, aliasesAtJudgement } = promotion;
    await connection.query(`SAVEPOINT ${AUTO_PROMOTION_SAVEPOINT}`);
    try {
      await lockModelAliases(connection, policy.modelId);
      const current = await readPromotionAliases(connection, policy);
      const unchanged =
        current.baselineVersionId === judgement.baselineVersionId &&
        current.targetVersionId === aliasesAtJudgement.targetVersionId;
      if (!unchanged || current.targetVersionId === record.candidateVersionId) {
        await insertPromotionEvaluation(connection, {
          ...record,
          reason: unchanged ? record.reason : 'baseline_changed',
        });
        await connection.query(`RELEASE SAVEPOINT ${AUTO_PROMOTION_SAVEPOINT}`);
        return;
      }
      // The alias event points at this decision before it exists; that foreign key is deferred.
      // The assignment always records an event: under this lock the alias points elsewhere.
      const evaluationId = randomUUID();
      const aliasEventId = (await assignModelAlias(connection, {
        modelId: policy.modelId,
        alias: policy.targetAlias,
        versionId: record.candidateVersionId,
        actor: { userId: policy.runAsUserId, tokenId: null },
        source: 'promotion_policy',
        reason: automaticPromotionReason(policy, judgement),
        evaluationId,
        guard: promotionAliasGuard(policy),
      }))!;
      // A concurrent judgement of the same Run already recorded its decision; undo this alias move.
      const recorded = await insertPromotionEvaluation(connection, {
        ...record,
        promotion: { id: evaluationId, aliasEventId },
      });
      if (!recorded) await connection.query(`ROLLBACK TO SAVEPOINT ${AUTO_PROMOTION_SAVEPOINT}`);
      await connection.query(`RELEASE SAVEPOINT ${AUTO_PROMOTION_SAVEPOINT}`);
    } catch (error) {
      await connection.query(`ROLLBACK TO SAVEPOINT ${AUTO_PROMOTION_SAVEPOINT}`);
      await connection.query(`RELEASE SAVEPOINT ${AUTO_PROMOTION_SAVEPOINT}`);
      logPromotionFailure('automatic_promotion_failed', {
        policy,
        candidate: { runId: record.candidateRunId },
        error,
      });
      await insertPromotionEvaluation(connection, { ...record, reason: 'promotion_denied' });
    }
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
