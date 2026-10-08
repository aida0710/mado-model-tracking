import type { ModelVersion, RunOutputRegistration, TaskOutputModel } from '@mmt/contracts';
import pg from 'pg';
import type { PoolClient } from 'pg';
import type { Connection } from '../db/database.js';
import { DomainError } from '../domain/errors.js';
import { renderVersionTemplate } from '../domain/outputModelVersionTemplate.js';
import { nameSchema } from '../domain/validation.js';
import {
  findLatestRunArtifact,
  findOrCreateOutputModel,
  findOutputModelById,
  findOutputRegistrationSource,
  findRunOutputRegistration,
  findVersionRegisteredByRun,
  insertRunOutputRegistration,
  type OutputRegistrationSource,
} from '../repositories/runOutputRegistrationRepository.js';
import type { ModelVersionRegistration } from './modelVersionRegistration.js';
import type { RunCompletionHandler, RunStatusChange } from './runCompletionService.js';

export interface ModelVersionRegistrar {
  registerModelVersion(
    connection: PoolClient,
    registration: ModelVersionRegistration,
  ): Promise<ModelVersion>;
}

// Stable codes stored in run_output_registrations.error; the Web maps them to messages.
type OutputRegistrationErrorCode =
  | 'model_not_found'
  | 'model_deleted'
  | 'model_family_mismatch'
  | 'artifact_not_found'
  | 'invalid_version'
  | 'version_conflict'
  | 'creator_access_revoked'
  | 'registration_failed';

class OutputRegistrationFailure extends Error {
  constructor(readonly code: OutputRegistrationErrorCode) {
    super(code);
  }
}

const REGISTRATION_SAVEPOINT = 'output_registration';
const UNIQUE_VIOLATION = '23505';

/**
 * Registers the Task's output model when a Run launched with one finishes successfully.
 * It runs inside the terminal transition, before pending automation, so the version it creates
 * starts downstream automation in the same completion. Failures are recorded, never thrown:
 * the Run stays finished (decisions.md) and a later completion of the same Run is a no-op.
 */
export class OutputRegistrationHandler implements RunCompletionHandler {
  readonly name = 'outputRegistration';

  constructor(private readonly registry: ModelVersionRegistrar) {}

  async handle(connection: Connection, change: RunStatusChange): Promise<void> {
    const { run } = change;
    if (run.status !== 'finished') return;
    const reference = { projectId: run.projectId, runId: run.id };
    const source = await findOutputRegistrationSource(connection, reference);
    if (!source?.outputModelRegistration) return;
    if (await findRunOutputRegistration(connection, reference)) return;
    const client = requireTransactionClient(connection);
    await client.query(`SAVEPOINT ${REGISTRATION_SAVEPOINT}`);
    let outcome: RunOutputRegistration;
    try {
      outcome = await this.register(client, {
        projectId: run.projectId,
        source,
        settings: source.outputModelRegistration,
      });
    } catch (error) {
      await client.query(`ROLLBACK TO SAVEPOINT ${REGISTRATION_SAVEPOINT}`);
      outcome = {
        status: 'failed',
        modelVersionId: null,
        error: failureCode(error, run.id),
        reason: null,
      };
    }
    await client.query(`RELEASE SAVEPOINT ${REGISTRATION_SAVEPOINT}`);
    await insertRunOutputRegistration(client, { ...reference, outcome });
  }

  private async register(
    connection: PoolClient,
    request: { projectId: string; source: OutputRegistrationSource; settings: TaskOutputModel },
  ): Promise<RunOutputRegistration> {
    const { projectId, source, settings } = request;
    const modelId = await resolveModel(connection, { projectId, settings });
    const existingVersionId = await findVersionRegisteredByRun(connection, {
      projectId,
      runId: source.id,
      modelId,
    });
    if (existingVersionId)
      return {
        status: 'skipped',
        modelVersionId: existingVersionId,
        error: null,
        reason: 'already_registered_by_run',
      };
    const artifactId = await findLatestRunArtifact(connection, {
      projectId,
      runId: source.id,
      path: settings.artifactPath,
    });
    if (!artifactId) throw new OutputRegistrationFailure('artifact_not_found');
    const version = await this.registry.registerModelVersion(connection, {
      projectId,
      modelId,
      version: settings.versionTemplate
        ? renderVersion(settings.versionTemplate, source)
        : undefined,
      sourceRunId: source.id,
      parentVersionIds: source.modelVersionId ? [source.modelVersionId] : [],
      artifactId,
      defaultCodeVersionId: settings.defaultCodeVersionId ?? null,
      metadata: settings.metadata ?? {},
      actor: { type: 'runCreator' },
    });
    return { status: 'registered', modelVersionId: version.id, error: null, reason: null };
  }
}

async function resolveModel(
  connection: PoolClient,
  request: { projectId: string; settings: TaskOutputModel },
): Promise<string> {
  const { projectId, settings } = request;
  const model = settings.createModel
    ? await findOrCreateOutputModel(connection, { projectId, ...settings.createModel })
    : await findOutputModelById(connection, { projectId, id: settings.modelId! });
  if (!model) throw new OutputRegistrationFailure('model_not_found');
  if (model.deleted) throw new OutputRegistrationFailure('model_deleted');
  // A same-named Model may have been created with another family after the Task was saved.
  if (settings.createModel && model.family !== settings.createModel.family)
    throw new OutputRegistrationFailure('model_family_mismatch');
  return model.id;
}

function renderVersion(template: string, source: OutputRegistrationSource): string {
  const version = nameSchema.safeParse(
    renderVersionTemplate(template, {
      runId: source.id,
      runName: source.name,
      taskRevision: source.taskRevision ?? 0,
    }),
  );
  if (!version.success) throw new OutputRegistrationFailure('invalid_version');
  return version.data;
}

function failureCode(error: unknown, runId: string): OutputRegistrationErrorCode {
  if (error instanceof OutputRegistrationFailure) return error.code;
  if (error instanceof DomainError && error.code === 'project_forbidden')
    return 'creator_access_revoked';
  if (error instanceof pg.DatabaseError && error.code === UNIQUE_VIOLATION)
    return 'version_conflict';
  console.error(
    JSON.stringify({
      event: 'output_registration_failed',
      runId,
      message: error instanceof Error ? error.message : String(error),
    }),
  );
  return 'registration_failed';
}

// Terminal transitions always run in a transaction; registration needs its client for savepoints.
function requireTransactionClient(connection: Connection): PoolClient {
  if (connection instanceof pg.Pool)
    throw new Error('Output registration must run inside the terminal-transition transaction');
  return connection;
}
