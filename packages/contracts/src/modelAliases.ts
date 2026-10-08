/**
 * Where an alias change came from. version_deleted / model_deleted are removals the server
 * makes because the target ModelVersion or Registered Model was deleted through MLflow.
 */
export type ModelAliasEventSource =
  'web' | 'api' | 'mlflow' | 'promotion_policy' | 'version_deleted' | 'model_deleted';

/** One append-only alias change. versionId null is a removal; previousVersionId null is a first assignment. */
export interface ModelAliasEvent {
  id: string;
  projectId: string;
  modelId: string;
  alias: string;
  previousVersionId: string | null;
  /** Version label of previousVersionId, e.g. "3". */
  previousVersion: string | null;
  versionId: string | null;
  version: string | null;
  source: ModelAliasEventSource;
  reason: string;
  promotionEvaluationId: string | null;
  /** null for changes made without a user (the migration snapshot and system-driven changes). */
  actor: { userId: string; displayName: string; tokenId: string | null } | null;
  createdAt: string;
}

/** One keyset page of alias events, newest first. nextCursor is the id to pass as `cursor` next. */
export interface ModelAliasEventPage {
  items: ModelAliasEvent[];
  nextCursor: string | null;
}

/** Body of PUT /projects/:p/models/:id/aliases/:alias. */
export interface ModelAliasAssignment {
  versionId: string;
  reason?: string;
  /**
   * A passed promotion decision for this alias and version, recorded as the change's evidence.
   * Required for an alias protected with requirePassedEvaluation.
   */
  evaluationId?: string;
}

/** The weakest current Project role that may change a protected alias by hand. */
export type ModelAliasProtectionRole = 'editor' | 'admin';

/**
 * Restricts manual changes of an alias. modelId null protects the alias on every Model of the
 * Project; when a Project-wide and a Model protection both match, the stricter setting of each
 * applies. Changes through the MLflow-compatible API are always rejected (PERMISSION_DENIED)
 * because they cannot carry a reason or a promotion decision.
 */
export interface ModelAliasProtection {
  id: string;
  projectId: string;
  modelId: string | null;
  alias: string;
  requiredRole: ModelAliasProtectionRole;
  /** A manual assignment must name a passed decision (evaluationId) for this alias and version. */
  requirePassedEvaluation: boolean;
  createdBy: string;
  createdAt: string;
  updatedBy: string;
  updatedAt: string;
}

/** Body of PUT /projects/:p/alias-protections/:alias?modelId=. */
export interface ModelAliasProtectionInput {
  requiredRole: ModelAliasProtectionRole;
  requirePassedEvaluation?: boolean;
}
