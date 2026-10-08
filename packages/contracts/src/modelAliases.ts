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
