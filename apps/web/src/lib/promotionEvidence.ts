import type {
  ModelAliasProtection,
  ModelAliasProtectionRole,
  ProjectRole,
  PromotionEvaluation,
  PromotionPolicy,
} from '@mmt/contracts';

// Mirrors the API's alias protection checks (aliasProtectionService.manualAliasGuard) so the
// promotion dialog asks for what the API will require. The API stays the authority.

/** What a manual change of one alias must satisfy once every matching protection is combined. */
export interface EffectiveAliasProtection {
  requiredRole: ModelAliasProtectionRole;
  requirePassedEvaluation: boolean;
}

/** The Project-wide and the Model protection combine into the stricter of each setting. */
export function effectiveAliasProtection(
  protections: readonly ModelAliasProtection[],
  target: { modelId: string; alias: string },
): EffectiveAliasProtection | null {
  const matching = protections.filter(
    (protection) =>
      protection.alias === target.alias &&
      (protection.modelId === null || protection.modelId === target.modelId),
  );
  if (!matching.length) return null;
  return {
    requiredRole: matching.some((protection) => protection.requiredRole === 'admin')
      ? 'admin'
      : 'editor',
    requirePassedEvaluation: matching.some((protection) => protection.requirePassedEvaluation),
  };
}

export function meetsProtectionRole(
  role: ProjectRole,
  protection: EffectiveAliasProtection | null,
): boolean {
  if (!protection) return true;
  return protection.requiredRole === 'editor' ? role !== 'viewer' : role === 'admin';
}

/**
 * The current decisions about the version under policies that target the alias: a later
 * re-evaluation of the same candidate Run replaces the earlier one, as the API judges it.
 */
export function currentDecisionsForAlias(
  decisions: readonly PromotionEvaluation[],
  context: { policies: readonly PromotionPolicy[]; alias: string; versionId: string },
): PromotionEvaluation[] {
  const policyIds = new Set(
    context.policies
      .filter((policy) => policy.targetAlias === context.alias)
      .map((policy) => policy.id),
  );
  const latest = new Map<string, PromotionEvaluation>();
  for (const decision of decisions) {
    if (!policyIds.has(decision.policyId) || decision.candidateVersionId !== context.versionId)
      continue;
    const key = `${decision.policyId}:${decision.candidateRunId}`;
    if ((latest.get(key)?.sequence ?? 0) < decision.sequence) latest.set(key, decision);
  }
  return [...latest.values()].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

/**
 * What the dialog must collect. A protected alias needs a passed decision when the protection says
 * so, and otherwise a reason when no decision is named. Moving any alias to a version that failed
 * its promotion check needs a reason too, so the history says why it was promoted anyway.
 */
export function promotionEvidenceRequirement(state: {
  protection: EffectiveAliasProtection | null;
  decisions: readonly PromotionEvaluation[];
  evaluationId: string;
}): { evaluationRequired: boolean; reasonRequired: boolean } {
  const evaluationRequired = state.protection?.requirePassedEvaluation === true;
  const failedCheck = state.decisions.some((decision) => decision.decision === 'failed');
  return {
    evaluationRequired,
    reasonRequired: !state.evaluationId && (state.protection !== null || failedCheck),
  };
}
