import type {
  ModelAliasEvent,
  ModelAliasEventSource,
  ModelAliasProtection,
  ModelAliasProtectionRole,
} from '@mmt/contracts';
import type { Principal } from '../auth/principal.js';
import { first, rows, type Connection } from '../db/database.js';
import { notFound } from '../domain/errors.js';

// Only assignModelAlias and removeModelAliases write model_aliases, so every change leaves an event
// and passes the caller's guard (alias protections) under the Model lock.

export interface ModelAliasActor {
  userId: string | null;
  tokenId: string | null;
}

export function modelAliasActor(principal: Principal): ModelAliasActor {
  return { userId: principal.user.id, tokenId: principal.token?.id ?? null };
}

/** One alias change as the guard sees it. versionId null is a removal. */
export interface GuardedModelAliasChange {
  projectId: string;
  modelId: string;
  alias: string;
  versionId: string | null;
}

/**
 * Decides whether the change may happen and throws a DomainError when it may not. Called after the
 * Model lock, so the alias and its protections cannot move between the check and the write.
 */
export type ModelAliasGuard = (
  connection: Connection,
  change: GuardedModelAliasChange,
) => Promise<void>;

interface ModelAliasChange {
  projectId: string;
  modelId: string;
  alias: string;
  previousVersionId: string | null;
  versionId: string | null;
  source: ModelAliasEventSource;
  reason: string;
  evaluationId: string | null;
  actor: ModelAliasActor;
}

// Serializes every alias change of one Model. A row lock on model_aliases alone cannot cover the
// first assignment (no row yet), and without this two concurrent first assignments would both
// record previous_version_id NULL. Returns the Model's project for the event row.
async function lockModel(connection: Connection, modelId: string): Promise<string> {
  const model = await first<{ projectId: string }>(
    connection,
    'SELECT project_id FROM models WHERE id=$1 FOR UPDATE',
    [modelId],
  );
  if (!model) notFound('Model');
  return model.projectId;
}

async function appendModelAliasEvent(
  connection: Connection,
  change: ModelAliasChange,
): Promise<string> {
  const event = await first<{ id: string }>(
    connection,
    // clock_timestamp, not the transaction start: the event is written after the Model lock, so
    // created_at follows the lock order and the history reads as a previous -> next chain.
    `INSERT INTO model_alias_events(project_id,model_id,alias,previous_version_id,version_id,source,
    reason,promotion_evaluation_id,actor_user_id,actor_token_id,created_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,clock_timestamp()) RETURNING id`,
    [
      change.projectId,
      change.modelId,
      change.alias,
      change.previousVersionId,
      change.versionId,
      change.source,
      change.reason,
      change.evaluationId,
      change.actor.userId,
      change.actor.tokenId,
    ],
  );
  return event!.id;
}

/**
 * Points the alias at versionId. Re-assigning the version it already points at changes nothing and
 * records no event, so SDK retries of the same set_registered_model_alias do not grow the history.
 * Returns the recorded event's id, or null when the alias already pointed at versionId.
 */
export async function assignModelAlias(
  connection: Connection,
  assignment: {
    modelId: string;
    alias: string;
    versionId: string;
    actor: ModelAliasActor;
    source: ModelAliasEventSource;
    reason?: string;
    evaluationId?: string | null;
    guard: ModelAliasGuard;
  },
): Promise<string | null> {
  const projectId = await lockModel(connection, assignment.modelId);
  const current = await first<{ versionId: string }>(
    connection,
    'SELECT version_id FROM model_aliases WHERE model_id=$1 AND alias=$2',
    [assignment.modelId, assignment.alias],
  );
  if (current?.versionId === assignment.versionId) return null;
  await assignment.guard(connection, {
    projectId,
    modelId: assignment.modelId,
    alias: assignment.alias,
    versionId: assignment.versionId,
  });
  await connection.query(
    'INSERT INTO model_aliases(model_id,alias,version_id) VALUES($1,$2,$3) ON CONFLICT(model_id,alias) DO UPDATE SET version_id=EXCLUDED.version_id',
    [assignment.modelId, assignment.alias, assignment.versionId],
  );
  return appendModelAliasEvent(connection, {
    projectId,
    modelId: assignment.modelId,
    alias: assignment.alias,
    previousVersionId: current?.versionId ?? null,
    versionId: assignment.versionId,
    source: assignment.source,
    reason: assignment.reason ?? '',
    evaluationId: assignment.evaluationId ?? null,
    actor: assignment.actor,
  });
}

/**
 * Removes the Model's aliases narrowed by alias or versionId (neither: all of them) and records one
 * removal event per alias actually removed. Returns the removed alias names.
 */
export async function removeModelAliases(
  connection: Connection,
  removal: {
    modelId: string;
    alias?: string;
    versionId?: string;
    actor: ModelAliasActor;
    source: ModelAliasEventSource;
    reason?: string;
    guard: ModelAliasGuard;
  },
): Promise<string[]> {
  const projectId = await lockModel(connection, removal.modelId);
  const targets = await rows<{ alias: string }>(
    connection,
    `SELECT alias FROM model_aliases WHERE model_id=$1 AND ($2::text IS NULL OR alias=$2)
    AND ($3::uuid IS NULL OR version_id=$3) ORDER BY alias`,
    [removal.modelId, removal.alias ?? null, removal.versionId ?? null],
  );
  for (const target of targets)
    await removal.guard(connection, {
      projectId,
      modelId: removal.modelId,
      alias: target.alias,
      versionId: null,
    });
  const removed = await rows<{ alias: string; versionId: string }>(
    connection,
    `DELETE FROM model_aliases WHERE model_id=$1 AND ($2::text IS NULL OR alias=$2)
    AND ($3::uuid IS NULL OR version_id=$3) RETURNING alias,version_id`,
    [removal.modelId, removal.alias ?? null, removal.versionId ?? null],
  );
  for (const alias of removed.sort((left, right) => left.alias.localeCompare(right.alias)))
    await appendModelAliasEvent(connection, {
      projectId,
      modelId: removal.modelId,
      alias: alias.alias,
      previousVersionId: alias.versionId,
      versionId: null,
      source: removal.source,
      reason: removal.reason ?? '',
      evaluationId: null,
      actor: removal.actor,
    });
  return removed.map((alias) => alias.alias);
}

const modelAliasEventSelect = `SELECT e.id,e.project_id,e.model_id,e.alias,e.previous_version_id,
  pv.version AS previous_version,e.version_id,v.version,e.source,e.reason,e.promotion_evaluation_id,
  CASE WHEN e.actor_user_id IS NULL THEN NULL ELSE jsonb_build_object('userId',u.id,
    'displayName',u.display_name,'tokenId',e.actor_token_id) END AS actor,e.created_at
  FROM model_alias_events e
  LEFT JOIN model_versions pv ON pv.id=e.previous_version_id
  LEFT JOIN model_versions v ON v.id=e.version_id
  LEFT JOIN users u ON u.id=e.actor_user_id`;

// Keyset pagination on (created_at,id) stays stable while new events are appended.
export function listModelAliasEvents(
  connection: Connection,
  filter: { modelId: string; alias?: string; cursor?: string; limit: number },
): Promise<ModelAliasEvent[]> {
  return rows<ModelAliasEvent>(
    connection,
    `${modelAliasEventSelect}
    WHERE e.model_id=$1 AND ($2::text IS NULL OR e.alias=$2)
      AND ($3::uuid IS NULL OR (e.created_at,e.id) < (SELECT created_at,id FROM model_alias_events WHERE id=$3))
    ORDER BY e.created_at DESC,e.id DESC LIMIT $4`,
    [filter.modelId, filter.alias ?? null, filter.cursor ?? null, filter.limit],
  );
}

// A cursor must belong to the listed Model so event IDs of other Models cannot be probed.
export async function modelAliasEventCursorExists(
  connection: Connection,
  cursor: { id: string; modelId: string },
): Promise<boolean> {
  return Boolean(
    await first(connection, 'SELECT id FROM model_alias_events WHERE id=$1 AND model_id=$2', [
      cursor.id,
      cursor.modelId,
    ]),
  );
}

/** The version the alias points at now, or null when it is unset. */
export async function findModelAliasVersion(
  connection: Connection,
  reference: { modelId: string; alias: string },
): Promise<string | null> {
  const current = await first<{ versionId: string }>(
    connection,
    'SELECT version_id FROM model_aliases WHERE model_id=$1 AND alias=$2',
    [reference.modelId, reference.alias],
  );
  return current?.versionId ?? null;
}

/** Takes the lock every alias change of the Model takes, so aliases read afterwards stay put. */
export async function lockModelAliases(connection: Connection, modelId: string): Promise<void> {
  await lockModel(connection, modelId);
}

// ---- Alias protections ----

const aliasProtectionColumns = `id,project_id,model_id,alias,required_role,require_passed_evaluation,
  created_by,created_at,updated_by,updated_at`;
const aliasProtectionSelect = `SELECT ${aliasProtectionColumns} FROM model_alias_protections`;

/** The Project-wide protections and, with modelId, that Model's protections (Project-wide first). */
export function listModelAliasProtections(
  connection: Connection,
  filter: { projectId: string; modelId?: string },
): Promise<ModelAliasProtection[]> {
  return rows<ModelAliasProtection>(
    connection,
    `${aliasProtectionSelect} WHERE project_id=$1
      AND ($2::uuid IS NULL OR model_id IS NULL OR model_id=$2)
    ORDER BY model_id NULLS FIRST,alias`,
    [filter.projectId, filter.modelId ?? null],
  );
}

/** Every protection that applies to the alias on the Model: the Project-wide one and the Model's own. */
export function findApplicableAliasProtections(
  connection: Connection,
  reference: { projectId: string; modelId: string; alias: string },
): Promise<ModelAliasProtection[]> {
  return rows<ModelAliasProtection>(
    connection,
    `${aliasProtectionSelect} WHERE project_id=$1 AND alias=$3 AND (model_id IS NULL OR model_id=$2)`,
    [reference.projectId, reference.modelId, reference.alias],
  );
}

export interface AliasProtectionTarget {
  projectId: string;
  /** null for the Project-wide protection. */
  modelId: string | null;
  alias: string;
}

/** Creates or replaces the protection of the alias; created_by and created_at keep the first values. */
export async function upsertModelAliasProtection(
  connection: Connection,
  protection: AliasProtectionTarget & {
    requiredRole: ModelAliasProtectionRole;
    requirePassedEvaluation: boolean;
    actorUserId: string;
  },
): Promise<ModelAliasProtection> {
  // The two partial unique indexes cannot share one ON CONFLICT target, so update first.
  const updated = await first<ModelAliasProtection>(
    connection,
    `UPDATE model_alias_protections SET required_role=$4,require_passed_evaluation=$5,updated_by=$6,
      updated_at=now()
    WHERE project_id=$1 AND model_id IS NOT DISTINCT FROM $2::uuid AND alias=$3
    RETURNING ${aliasProtectionColumns}`,
    [
      protection.projectId,
      protection.modelId,
      protection.alias,
      protection.requiredRole,
      protection.requirePassedEvaluation,
      protection.actorUserId,
    ],
  );
  if (updated) return updated;
  return (await first<ModelAliasProtection>(
    connection,
    `INSERT INTO model_alias_protections(project_id,model_id,alias,required_role,
      require_passed_evaluation,created_by,updated_by)
    VALUES($1,$2,$3,$4,$5,$6,$6)
    RETURNING ${aliasProtectionColumns}`,
    [
      protection.projectId,
      protection.modelId,
      protection.alias,
      protection.requiredRole,
      protection.requirePassedEvaluation,
      protection.actorUserId,
    ],
  ))!;
}

/** Returns the removed protection, or undefined when the alias was not protected at that level. */
export function deleteModelAliasProtection(
  connection: Connection,
  target: AliasProtectionTarget,
): Promise<ModelAliasProtection | undefined> {
  return first<ModelAliasProtection>(
    connection,
    `DELETE FROM model_alias_protections
    WHERE project_id=$1 AND model_id IS NOT DISTINCT FROM $2::uuid AND alias=$3
    RETURNING ${aliasProtectionColumns}`,
    [target.projectId, target.modelId, target.alias],
  );
}
