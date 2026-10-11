import type { ModelAliasProtection } from '@mmt/contracts';
import type { Principal } from '../auth/principal.js';
import { transaction, type Connection, type Database } from '../db/database.js';
import { DomainError, notFound } from '../domain/errors.js';
import {
  combineAliasProtections,
  type ModelAliasProtectionInput,
} from '../domain/modelAliasValidation.js';
import { satisfiesProjectRole } from '../domain/projectRoles.js';
import type { RequestMetadata } from '../http/requestMetadata.js';
import { writeAuditEvent } from '../repositories/auditRepository.js';
import {
  deleteModelAliasProtection,
  findApplicableAliasProtections,
  listModelAliasProtections,
  upsertModelAliasProtection,
  type AliasProtectionTarget,
  type GuardedModelAliasChange,
  type ModelAliasGuard,
} from '../repositories/modelAliasRepository.js';
import {
  findPromotionEvidence,
  hasPromotionRunAsAccess,
} from '../repositories/promotionRepository.js';
import { assertProjectReference } from '../repositories/registryRepository.js';
import { requireProject } from './accessService.js';
import {
  auditActor,
  NO_REQUEST_METADATA,
  recordDenial,
  type AuditEventDraft,
} from './auditService.js';

function aliasProtected(message: string): never {
  throw new DomainError(403, message, 'alias_protected');
}

/**
 * The evidence must be the current decision of a policy for this very alias, Model and version,
 * and it must have passed. A later re-evaluation of the same candidate Run replaces it.
 */
async function requirePassedEvidence(
  connection: Connection,
  evidence: GuardedModelAliasChange & { versionId: string; evaluationId: string },
): Promise<void> {
  const decision = await findPromotionEvidence(connection, {
    projectId: evidence.projectId,
    id: evidence.evaluationId,
  });
  if (!decision) notFound('PromotionEvaluation');
  if (
    decision.modelId !== evidence.modelId ||
    decision.candidateVersionId !== evidence.versionId ||
    decision.targetAlias !== evidence.alias
  )
    throw new DomainError(
      422,
      '根拠の判定は、同じModel・同じバージョン・同じaliasを対象にしたものを指定してください',
      'alias_evaluation_mismatch',
    );
  if (decision.decision !== 'passed' || !decision.isLatest)
    throw new DomainError(
      409,
      '根拠の判定が合格ではありません（再判定で置き換わった判定も使えません）',
      'alias_evaluation_not_passed',
    );
}

/**
 * Guard of alias changes made by hand through the native API (Web, SDK, API tokens).
 * A protected alias needs the protection's role; an assignment also needs evidence: a passed
 * decision (always, with requirePassedEvaluation) or at least a reason. Removing an alias that
 * requires a passed decision takes Project admin, since no decision can justify a removal.
 * A named decision is checked even on an unprotected alias, because the alias event records it.
 */
export function manualAliasGuard(
  principal: Principal,
  evidence: { evaluationId?: string; reason?: string } = {},
): ModelAliasGuard {
  return async (connection, change) => {
    const protection = combineAliasProtections(
      await findApplicableAliasProtections(connection, change),
    );
    if (protection) {
      const role = await requireProject(connection, principal, {
        projectId: change.projectId,
        role: 'viewer',
        scope: 'registry:write',
      });
      if (!satisfiesProjectRole(role, protection.requiredRole))
        aliasProtected(
          `保護alias「${change.alias}」の変更にはProjectの${protection.requiredRole}権限が必要です`,
        );
      if (change.versionId === null && protection.requirePassedEvaluation && role !== 'admin')
        aliasProtected(
          `合格判定が必要な保護alias「${change.alias}」の解除にはProject adminが必要です`,
        );
    }
    if (change.versionId === null) return;
    if (evidence.evaluationId)
      await requirePassedEvidence(connection, {
        ...change,
        versionId: change.versionId,
        evaluationId: evidence.evaluationId,
      });
    if (!protection || evidence.evaluationId) return;
    if (protection.requirePassedEvaluation)
      throw new DomainError(
        422,
        `保護alias「${change.alias}」を変更するには、このバージョンの合格判定（evaluationId）を指定してください`,
        'alias_evaluation_required',
      );
    if (!evidence.reason?.trim())
      throw new DomainError(
        422,
        `保護alias「${change.alias}」を合格判定なしで変更するには理由を入力してください`,
        'alias_reason_required',
      );
  };
}

/**
 * Guard of the MLflow-compatible API. It can carry neither a reason nor a promotion decision, so
 * no protected alias can be changed or removed through it (decisions.md), including the removals
 * that deleting a ModelVersion or Registered Model would make.
 */
export const mlflowAliasGuard: ModelAliasGuard = async (connection, change) => {
  if ((await findApplicableAliasProtections(connection, change)).length)
    aliasProtected(
      `保護alias「${change.alias}」はMLflow互換APIから変更できません。Webかnative APIで理由か合格判定を付けて変更してください`,
    );
};

/**
 * Guard of an automatic promotion. The policy acts only while its run-as user is Project admin or
 * a global administrator, which meets every requiredRole, and its passed decision for this alias
 * and version is the evidence a protection asks for. The authority is re-read under the Model lock.
 */
export function promotionAliasGuard(policy: {
  projectId: string;
  runAsUserId: string;
}): ModelAliasGuard {
  return async (connection, change) => {
    if (!(await hasPromotionRunAsAccess(connection, policy)))
      aliasProtected(
        `昇格policyの実行ユーザーには保護alias「${change.alias}」を変更する権限がありません`,
      );
  };
}

export class AliasProtectionService {
  constructor(private readonly database: Database) {}

  /** Viewers may read the protections: the Web shows them before a change is attempted. */
  async list(
    principal: Principal,
    filter: { projectId: string; modelId?: string },
  ): Promise<ModelAliasProtection[]> {
    await requireProject(this.database, principal, {
      projectId: filter.projectId,
      role: 'viewer',
      scope: 'read',
    });
    return listModelAliasProtections(this.database, filter);
  }

  async set(
    principal: Principal,
    change: AliasProtectionTarget & { input: ModelAliasProtectionInput },
    request: RequestMetadata = NO_REQUEST_METADATA,
  ): Promise<ModelAliasProtection> {
    const { input, ...target } = change;
    const draft = this.protectionDraft(principal, {
      action: 'model_alias.protection.set',
      target,
      request,
    });
    return recordDenial(this.database, draft, () =>
      transaction(this.database, async (connection) => {
        await this.requireProtectionAdmin(connection, principal, target);
        const protection = await upsertModelAliasProtection(connection, {
          ...target,
          requiredRole: input.requiredRole,
          requirePassedEvaluation: input.requirePassedEvaluation,
          actorUserId: principal.user.id,
        });
        await writeAuditEvent(connection, {
          ...draft,
          outcome: 'success',
          resourceId: protection.id,
          details: { ...draft.details, ...input },
        });
        return protection;
      }),
    );
  }

  async remove(
    principal: Principal,
    target: AliasProtectionTarget,
    request: RequestMetadata = NO_REQUEST_METADATA,
  ): Promise<void> {
    const draft = this.protectionDraft(principal, {
      action: 'model_alias.protection.delete',
      target,
      request,
    });
    await recordDenial(this.database, draft, () =>
      transaction(this.database, async (connection) => {
        await this.requireProtectionAdmin(connection, principal, target);
        const removed = await deleteModelAliasProtection(connection, target);
        if (!removed) notFound('ModelAliasProtection');
        await writeAuditEvent(connection, {
          ...draft,
          outcome: 'success',
          resourceId: removed.id,
          details: {
            ...draft.details,
            requiredRole: removed.requiredRole,
            requirePassedEvaluation: removed.requirePassedEvaluation,
          },
        });
      }),
    );
  }

  // Same rule as promotion policies: Project admin or global administrator, admin scope for tokens.
  private async requireProtectionAdmin(
    connection: Connection,
    principal: Principal,
    target: AliasProtectionTarget,
  ): Promise<void> {
    await requireProject(connection, principal, {
      projectId: target.projectId,
      role: principal.user.isAdmin ? 'viewer' : 'admin',
      scope: 'admin',
    });
    if (target.modelId)
      await assertProjectReference(connection, {
        table: 'models',
        projectId: target.projectId,
        id: target.modelId,
      });
  }

  private protectionDraft(
    principal: Principal,
    change: { action: string; target: AliasProtectionTarget; request: RequestMetadata },
  ): AuditEventDraft {
    return {
      ...auditActor(principal),
      ...change.request,
      action: change.action,
      resourceType: 'model_alias_protection',
      resourceId: null,
      projectId: change.target.projectId,
      details: { alias: change.target.alias, modelId: change.target.modelId },
    };
  }
}
