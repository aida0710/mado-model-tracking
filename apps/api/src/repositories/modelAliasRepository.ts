import type { ModelAliasEvent, ModelAliasEventSource } from '@mmt/contracts';
import type { Principal } from '../auth/principal.js';
import { first, rows, type Connection } from '../db/database.js';
import { notFound } from '../domain/errors.js';

// Only assignModelAlias and removeModelAliases write model_aliases, so every change leaves an event.

export interface ModelAliasActor {
  userId: string | null;
  tokenId: string | null;
}

export function modelAliasActor(principal: Principal): ModelAliasActor {
  return { userId: principal.user.id, tokenId: principal.token?.id ?? null };
}

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
): Promise<void> {
  await connection.query(
    // clock_timestamp, not the transaction start: the event is written after the Model lock, so
    // created_at follows the lock order and the history reads as a previous -> next chain.
    `INSERT INTO model_alias_events(project_id,model_id,alias,previous_version_id,version_id,source,
    reason,promotion_evaluation_id,actor_user_id,actor_token_id,created_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,clock_timestamp())`,
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
}

/**
 * Points the alias at versionId. Re-assigning the version it already points at changes nothing and
 * records no event, so SDK retries of the same set_registered_model_alias do not grow the history.
 * Returns whether the alias changed.
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
  },
): Promise<boolean> {
  const projectId = await lockModel(connection, assignment.modelId);
  const current = await first<{ versionId: string }>(
    connection,
    'SELECT version_id FROM model_aliases WHERE model_id=$1 AND alias=$2',
    [assignment.modelId, assignment.alias],
  );
  if (current?.versionId === assignment.versionId) return false;
  await connection.query(
    'INSERT INTO model_aliases(model_id,alias,version_id) VALUES($1,$2,$3) ON CONFLICT(model_id,alias) DO UPDATE SET version_id=EXCLUDED.version_id',
    [assignment.modelId, assignment.alias, assignment.versionId],
  );
  await appendModelAliasEvent(connection, {
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
  return true;
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
  },
): Promise<string[]> {
  const projectId = await lockModel(connection, removal.modelId);
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
