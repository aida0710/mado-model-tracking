import type { JsonObject, Model, ModelVersion, RunKind } from '@mmt/contracts';
import type { PoolClient } from 'pg';
import type { Principal } from '../auth/principal.js';
import { first, type Connection } from '../db/database.js';
import { validateCodeCompatibility } from '../domain/compatibility.js';
import { DomainError, notFound } from '../domain/errors.js';
import { isTerminalStatus } from '../domain/runTransitions.js';
import { reserveModelVersion } from '../repositories/modelVersionNumbering.js';
import {
  assertProjectReferences,
  findCodeVersion,
  findRun,
} from '../repositories/registryRepository.js';
import { findSavedArtifact } from '../repositories/runtimeArtifactRepository.js';
import { requireProject } from './accessService.js';
import type { ModelAutomationService } from './modelAutomationService.js';
import { enqueueRunEvent } from './outboxEvents.js';

export type ModelVersionRegistrationActor =
  | { type: 'principal'; principal: Principal }
  // Run completion handlers and worker output declarations act as the source Run's creator.
  | { type: 'runCreator' };

export interface ModelVersionRegistration {
  projectId: string;
  modelId: string;
  // Omitted versions are numbered from models.next_version.
  version?: string;
  sourceRunId?: string | null;
  parentVersionIds: string[];
  artifactId?: string | null;
  weightsUri?: string | null;
  defaultCodeVersionId?: string | null;
  metadata: JsonObject;
  actor: ModelVersionRegistrationActor;
}

interface OutputSourceRun {
  id: string;
  kind: RunKind;
  lifecycleStage: 'active' | 'deleted';
  createdBy: string;
}

const OUTPUT_MODEL_RUN_KINDS: readonly RunKind[] = ['training', 'finetuning'];

/**
 * Inserts an immutable ModelVersion and starts model automation in the caller's transaction.
 * The source Run takes FOR KEY SHARE, the same lock as the model_versions FK: MLflow
 * registration already holds the Logged Model lock here, and a stronger Run lock would
 * deadlock with runs/outputs, which locks Run before Logged Model.
 */
export async function registerModelVersion(
  connection: PoolClient,
  registration: ModelVersionRegistration,
  automation: ModelAutomationService,
): Promise<ModelVersion> {
  const { projectId, actor } = registration;
  if (actor.type === 'principal')
    await requireProject(connection, actor.principal, {
      projectId,
      role: 'editor',
      scope: 'registry:write',
    });
  const sourceRun = registration.sourceRunId
    ? await lockOutputSourceRun(connection, { projectId, id: registration.sourceRunId })
    : null;
  if (actor.type === 'runCreator') {
    if (!sourceRun)
      throw new DomainError(
        422,
        'Runの作成者として登録するにはsourceRunIdが必要です',
        'source_run_required',
      );
    await requireRunCreatorRegistryAccess(connection, { projectId, userId: sourceRun.createdBy });
  }
  const version = await reserveModelVersion(connection, {
    projectId,
    modelId: registration.modelId,
    version: registration.version,
  });
  const model = (await first<Pick<Model, 'id' | 'family'>>(
    connection,
    'SELECT id,family FROM models WHERE id=$1',
    [registration.modelId],
  ))!;
  await assertProjectReferences(connection, {
    table: 'model_versions',
    projectId,
    ids: registration.parentVersionIds,
  });
  if (registration.artifactId)
    await findSavedArtifact(connection, { projectId, artifactId: registration.artifactId });
  if (registration.defaultCodeVersionId)
    validateCodeCompatibility(
      await findCodeVersion(connection, { projectId, id: registration.defaultCodeVersionId }),
      { model },
    );
  const inserted = (await first<Omit<ModelVersion, 'family'>>(
    connection,
    `INSERT INTO model_versions(model_id,project_id,version,source_run_id,parent_model_version_ids,weights_uri,artifact_id,default_code_version_id,metadata)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [
      model.id,
      projectId,
      version,
      sourceRun?.id ?? null,
      registration.parentVersionIds,
      registration.weightsUri ?? null,
      registration.artifactId ?? null,
      registration.defaultCodeVersionId ?? null,
      JSON.stringify(registration.metadata),
    ],
  ))!;
  await automation.processRegistration(connection, { projectId, modelVersionId: inserted.id });
  if (sourceRun) {
    // Terminal transitions lock the Run FOR UPDATE, so they either wait for this transaction and
    // list the version themselves, or committed before it; only then does the event need resending.
    const currentRun = await findRun(connection, { projectId, id: sourceRun.id });
    if (isTerminalStatus(currentRun.status)) await enqueueRunEvent(connection, currentRun);
  }
  return { ...inserted, family: model.family };
}

async function lockOutputSourceRun(
  connection: Connection,
  reference: { projectId: string; id: string },
): Promise<OutputSourceRun> {
  const run = await first<OutputSourceRun>(
    connection,
    'SELECT id,kind,lifecycle_stage,created_by FROM runs WHERE project_id=$1 AND id=$2 FOR KEY SHARE',
    [reference.projectId, reference.id],
  );
  if (!run) notFound('Run');
  if (!OUTPUT_MODEL_RUN_KINDS.includes(run.kind))
    throw new DomainError(
      422,
      '出力モデルのsource Runはtrainingまたはfinetuningである必要があります',
      'output_model_kind',
    );
  if (run.lifecycleStage !== 'active')
    throw new DomainError(422, '削除済みRunには出力モデルを登録できません', 'source_run_deleted');
  return run;
}

async function requireRunCreatorRegistryAccess(
  connection: Connection,
  member: { projectId: string; userId: string },
): Promise<void> {
  // The system actor does not inherit a global administrator's session-only access. Group
  // bindings count like direct grants, as they do for every other authorization decision.
  const membership = await first(
    connection,
    "SELECT 1 FROM effective_project_roles WHERE project_id=$1 AND user_id=$2 AND role IN ('editor','admin')",
    [member.projectId, member.userId],
  );
  if (!membership)
    throw new DomainError(403, 'Runの作成者にProjectの編集権限がありません', 'project_forbidden');
}
