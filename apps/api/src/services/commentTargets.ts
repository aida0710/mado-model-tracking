import type { CommentTargetType } from '@mmt/contracts';
import { first, type Connection } from '../db/database.js';
import { DomainError } from '../domain/errors.js';

export type CommentTargetState = 'active' | 'deleted';

/**
 * How comments attach to one kind of target. findState returns undefined when the target does not
 * exist in the Project, and should lock the target row so it cannot be deleted mid-transaction.
 */
export interface CommentTargetDefinition {
  writeScope: string;
  findState(
    connection: Connection,
    target: { projectId: string; targetId: string },
  ): Promise<CommentTargetState | undefined>;
}

export class CommentTargetRegistry {
  private readonly definitions = new Map<CommentTargetType, CommentTargetDefinition>();

  // Reports are registered by their own service, so their table is not referenced from here.
  registerCommentTarget(targetType: CommentTargetType, definition: CommentTargetDefinition): void {
    if (this.definitions.has(targetType))
      throw new Error(`Comment target already registered: ${targetType}`);
    this.definitions.set(targetType, definition);
  }

  definition(targetType: CommentTargetType): CommentTargetDefinition {
    const definition = this.definitions.get(targetType);
    if (!definition)
      throw new DomainError(
        422,
        'この種類の対象にはまだコメントできません',
        'comment_target_unsupported',
      );
    return definition;
  }
}

const runTarget: CommentTargetDefinition = {
  writeScope: 'runs:write',
  async findState(connection, target) {
    const run = await first<{ lifecycleStage: CommentTargetState }>(
      connection,
      'SELECT lifecycle_stage FROM runs WHERE id=$1 AND project_id=$2 FOR SHARE',
      [target.targetId, target.projectId],
    );
    return run?.lifecycleStage;
  },
};

// A version is deleted when it or its registered model was deleted through the MLflow registry.
const modelVersionTarget: CommentTargetDefinition = {
  writeScope: 'registry:write',
  async findState(connection, target) {
    const version = await first<{ deleted: boolean }>(
      connection,
      `SELECT (vm.deleted_at IS NOT NULL OR mm.deleted_at IS NOT NULL) AS deleted
      FROM model_versions v
      LEFT JOIN mlflow_model_version_metadata vm ON vm.version_id=v.id
      LEFT JOIN mlflow_registered_model_metadata mm ON mm.model_id=v.model_id
      WHERE v.id=$1 AND v.project_id=$2 FOR SHARE OF v`,
      [target.targetId, target.projectId],
    );
    if (!version) return undefined;
    return version.deleted ? 'deleted' : 'active';
  },
};

export function createCommentTargetRegistry(): CommentTargetRegistry {
  const registry = new CommentTargetRegistry();
  registry.registerCommentTarget('run', runTarget);
  registry.registerCommentTarget('model_version', modelVersionTarget);
  return registry;
}
