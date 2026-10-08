import type {
  Code,
  CodeVersion,
  Dataset,
  DatasetVersion,
  Model,
  ModelAliasEventPage,
  ModelAliasEventSource,
  ModelVersion,
} from '@mmt/contracts';
import type { Principal } from '../auth/principal.js';
import type { PoolClient } from 'pg';
import { first, rows, transaction, type Database, type Connection } from '../db/database.js';
import type {
  CodeVersionCreate,
  DatasetVersionCreate,
  ModelVersionCreate,
} from '../domain/validation.js';
import type { DatasetVersionRequest } from '../domain/datasetContentValidation.js';
import { DomainError, notFound } from '../domain/errors.js';
import {
  assertProjectReference,
  codeSelect,
  datasetSelect,
  datasetVersionSelect,
  modelColumns,
  modelSelect,
  modelVersionSelect,
} from '../repositories/registryRepository.js';
import { requireProject } from './accessService.js';
import { resolveDatasetContent } from './datasetContentService.js';
import { registerDatasetVersion } from './datasetVersionRegistration.js';
import type { ModelAutomationService } from './modelAutomationService.js';
import { validateCodeArtifacts } from '../repositories/runtimeArtifactRepository.js';
import { registerModelVersion, type ModelVersionRegistration } from './modelVersionRegistration.js';
import {
  assignModelAlias,
  listModelAliasEvents,
  modelAliasActor,
  modelAliasEventCursorExists,
  removeModelAliases,
} from '../repositories/modelAliasRepository.js';
import type { ModelAliasEventQuery } from '../domain/modelAliasValidation.js';
import { manualAliasGuard } from './aliasProtectionService.js';

// Browser sessions are the Web UI; API tokens are scripts and the SDK's native client.
function nativeAliasSource(principal: Principal): ModelAliasEventSource {
  return principal.method === 'session' ? 'web' : 'api';
}

export class RegistryService {
  constructor(
    private readonly database: Database,
    private readonly automation: ModelAutomationService,
  ) {}

  async models(
    principal: Principal,
    projectId: string,
    filter: { name?: string } = {},
  ): Promise<Model[]> {
    await this.requireReadAccess(principal, projectId);
    return rows(
      this.database,
      `${modelSelect} WHERE m.project_id=$1 AND ($2::text IS NULL OR m.name=$2) ORDER BY m.created_at DESC`,
      [projectId, filter.name ?? null],
    );
  }

  async createModel(
    principal: Principal,
    projectId: string,
    input: { name: string; family: string; description: string },
  ): Promise<Model> {
    await this.requireWriteAccess(this.database, principal, projectId);
    const model = (await first<Omit<Model, 'latestVersion' | 'aliases'>>(
      this.database,
      `INSERT INTO models(project_id,name,family,description) VALUES($1,$2,$3,$4) RETURNING ${modelColumns}`,
      [projectId, input.name, input.family, input.description],
    ))!;
    return { ...model, latestVersion: null, aliases: {} };
  }

  async modelVersions(
    principal: Principal,
    projectId: string,
    modelId: string,
  ): Promise<ModelVersion[]> {
    await this.requireReadAccess(principal, projectId);
    await assertProjectReference(this.database, {
      table: 'models',
      projectId,
      id: modelId,
    });
    return rows(
      this.database,
      `${modelVersionSelect} WHERE v.project_id=$1 AND v.model_id=$2 ORDER BY v.created_at DESC`,
      [projectId, modelId],
    );
  }

  async createModelVersion(
    principal: Principal,
    projectId: string,
    registration: { modelId: string; input: ModelVersionCreate },
  ): Promise<ModelVersion> {
    const { input } = registration;
    return transaction(this.database, (connection) =>
      this.registerModelVersion(connection, {
        projectId,
        modelId: registration.modelId,
        version: input.version,
        sourceRunId: input.sourceRunId,
        parentVersionIds: input.parentModelVersionIds,
        artifactId: input.artifactId,
        weightsUri: input.weightsUri,
        defaultCodeVersionId: input.defaultCodeVersionId,
        metadata: input.metadata,
        actor: { type: 'principal', principal },
      }),
    );
  }

  // Internal entry point for MLflow, Run completion, and worker registrations.
  registerModelVersion(
    connection: PoolClient,
    registration: ModelVersionRegistration,
  ): Promise<ModelVersion> {
    return registerModelVersion(connection, registration, this.automation);
  }

  async setAlias(
    principal: Principal,
    projectId: string,
    registration: {
      modelId: string;
      alias: string;
      versionId: string;
      reason?: string;
      evaluationId?: string;
    },
  ): Promise<Model> {
    return transaction(this.database, async (connection) => {
      await this.requireWriteAccess(connection, principal, projectId);
      await assertProjectReference(connection, {
        table: 'models',
        projectId,
        id: registration.modelId,
      });
      const version = await first(
        connection,
        'SELECT id FROM model_versions WHERE id=$1 AND project_id=$2 AND model_id=$3',
        [registration.versionId, projectId, registration.modelId],
      );
      if (!version) notFound('ModelVersion');
      await assignModelAlias(connection, {
        modelId: registration.modelId,
        alias: registration.alias,
        versionId: registration.versionId,
        actor: modelAliasActor(principal),
        source: nativeAliasSource(principal),
        reason: registration.reason,
        evaluationId: registration.evaluationId,
        guard: manualAliasGuard(principal, registration),
      });
      return (await first<Model>(connection, `${modelSelect} WHERE m.id=$1`, [
        registration.modelId,
      ]))!;
    });
  }

  async removeAlias(
    principal: Principal,
    projectId: string,
    removal: { modelId: string; alias: string; reason?: string },
  ): Promise<void> {
    await transaction(this.database, async (connection) => {
      await this.requireWriteAccess(connection, principal, projectId);
      await assertProjectReference(connection, {
        table: 'models',
        projectId,
        id: removal.modelId,
      });
      const removed = await removeModelAliases(connection, {
        modelId: removal.modelId,
        alias: removal.alias,
        actor: modelAliasActor(principal),
        source: nativeAliasSource(principal),
        reason: removal.reason,
        guard: manualAliasGuard(principal),
      });
      if (!removed.length) notFound('Model alias');
    });
  }

  async aliasEvents(
    principal: Principal,
    projectId: string,
    request: { modelId: string; query: ModelAliasEventQuery },
  ): Promise<ModelAliasEventPage> {
    await this.requireReadAccess(principal, projectId);
    await assertProjectReference(this.database, {
      table: 'models',
      projectId,
      id: request.modelId,
    });
    const { query } = request;
    if (
      query.cursor &&
      !(await modelAliasEventCursorExists(this.database, {
        id: query.cursor,
        modelId: request.modelId,
      }))
    )
      notFound('ModelAliasEvent cursor');
    // Fetch one extra row to know whether another page exists without a count query.
    const events = await listModelAliasEvents(this.database, {
      modelId: request.modelId,
      alias: query.alias,
      cursor: query.cursor,
      limit: query.limit + 1,
    });
    const items = events.slice(0, query.limit);
    return { items, nextCursor: events.length > query.limit ? items.at(-1)!.id : null };
  }

  async codes(principal: Principal, projectId: string): Promise<Code[]> {
    await this.requireReadAccess(principal, projectId);
    return rows(this.database, `${codeSelect} WHERE c.project_id=$1 ORDER BY c.created_at DESC`, [
      projectId,
    ]);
  }

  async createCode(
    principal: Principal,
    projectId: string,
    input: { name: string; description: string },
  ): Promise<Code> {
    await this.requireWriteAccess(this.database, principal, projectId);
    const code = (await first<Omit<Code, 'latestVersion'>>(
      this.database,
      'INSERT INTO codes(project_id,name,description) VALUES($1,$2,$3) RETURNING *',
      [projectId, input.name, input.description],
    ))!;
    return { ...code, latestVersion: null };
  }

  async codeVersions(
    principal: Principal,
    projectId: string,
    codeId: string,
  ): Promise<CodeVersion[]> {
    await this.requireReadAccess(principal, projectId);
    await assertProjectReference(this.database, {
      table: 'codes',
      projectId,
      id: codeId,
    });
    return rows(
      this.database,
      'SELECT * FROM code_versions WHERE project_id=$1 AND code_id=$2 ORDER BY created_at DESC',
      [projectId, codeId],
    );
  }

  async createCodeVersion(
    principal: Principal,
    projectId: string,
    registration: { codeId: string; input: CodeVersionCreate },
  ): Promise<CodeVersion> {
    return transaction(this.database, async (connection) => {
      await this.requireWriteAccess(connection, principal, projectId);
      await assertProjectReference(connection, {
        table: 'codes',
        projectId,
        id: registration.codeId,
      });
      const input = registration.input;
      await validateCodeArtifacts(connection, {
        projectId,
        source: input.source,
        runtime: input.runtime,
      });
      return (await first<CodeVersion>(
        connection,
        `INSERT INTO code_versions(code_id,project_id,version,source,entrypoint,requirements,environment,supported_model_families,task_types,runtime,test_entrypoint)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [
          registration.codeId,
          projectId,
          input.version,
          input.source === null ? null : JSON.stringify(input.source),
          input.entrypoint,
          input.requirements,
          JSON.stringify(input.environment),
          input.supportedModelFamilies,
          input.taskTypes,
          JSON.stringify(input.runtime),
          input.testEntrypoint,
        ],
      ))!;
    });
  }

  async datasets(principal: Principal, projectId: string): Promise<Dataset[]> {
    await this.requireReadAccess(principal, projectId);
    return rows(
      this.database,
      `${datasetSelect} WHERE d.project_id=$1 ORDER BY d.created_at DESC`,
      [projectId],
    );
  }

  async createDataset(
    principal: Principal,
    projectId: string,
    input: { name: string; namespace: string; description: string },
  ): Promise<Dataset> {
    await this.requireWriteAccess(this.database, principal, projectId);
    const dataset = (await first<Omit<Dataset, 'latestVersion'>>(
      this.database,
      'INSERT INTO datasets(project_id,name,namespace,description) VALUES($1,$2,$3,$4) RETURNING *',
      [projectId, input.name, input.namespace, input.description],
    ))!;
    return { ...dataset, latestVersion: null };
  }

  async datasetVersions(
    principal: Principal,
    projectId: string,
    datasetId: string,
  ): Promise<DatasetVersion[]> {
    await this.requireReadAccess(principal, projectId);
    await assertProjectReference(this.database, {
      table: 'datasets',
      projectId,
      id: datasetId,
    });
    return rows(
      this.database,
      `${datasetVersionSelect} WHERE v.project_id=$1 AND v.dataset_id=$2 ORDER BY v.created_at DESC`,
      [projectId, datasetId],
    );
  }

  /**
   * Native version creation. Artifact content is resolved after the write check, so a caller
   * without access learns nothing about the Project's Artifacts or Runs.
   */
  async createDatasetVersion(
    principal: Principal,
    projectId: string,
    registration: { datasetId: string; input: DatasetVersionRequest },
  ): Promise<DatasetVersion> {
    return transaction(this.database, async (connection) => {
      await this.requireWriteAccess(connection, principal, projectId);
      const { input } = registration;
      const common = {
        projectId,
        datasetId: registration.datasetId,
        version: input.version,
        schema: input.schema,
        metadata: input.metadata,
        parentDatasetVersionIds: input.parentDatasetVersionIds,
        actor: { type: 'callerAuthorized' as const },
      };
      if (!input.content)
        return registerDatasetVersion(connection, {
          ...common,
          // The request schema requires uri and digest when content is absent.
          uri: input.uri!,
          digest: input.digest!,
          sourceRunId: input.sourceRunId,
          externalRef: input.externalRef,
        });
      const resolved = await resolveDatasetContent(connection, {
        projectId,
        content: input.content,
      });
      if (resolved.sourceRunId && input.sourceRunId && input.sourceRunId !== resolved.sourceRunId)
        throw new DomainError(
          422,
          'sourceRunIdはfromRunArtifactsのRunと同じにしてください',
          'dataset_source_run_mismatch',
        );
      return registerDatasetVersion(connection, {
        ...common,
        content: { files: resolved.files },
        digest: input.digest,
        sourceRunId: input.sourceRunId ?? resolved.sourceRunId,
      });
    });
  }

  /**
   * Reference versions for callers that authorized the principal themselves: MLflow log_inputs
   * and plugin imports.
   */
  insertDatasetVersion(
    connection: Connection,
    projectId: string,
    registration: { datasetId: string; input: DatasetVersionCreate },
  ): Promise<DatasetVersion> {
    const { input } = registration;
    return registerDatasetVersion(connection, {
      projectId,
      datasetId: registration.datasetId,
      version: input.version,
      uri: input.uri,
      digest: input.digest,
      schema: input.schema,
      metadata: input.metadata,
      sourceRunId: input.sourceRunId,
      parentDatasetVersionIds: input.parentDatasetVersionIds,
      externalRef: input.externalRef,
      actor: { type: 'callerAuthorized' },
    });
  }

  private async requireReadAccess(principal: Principal, projectId: string): Promise<void> {
    await requireProject(this.database, principal, {
      projectId,
      role: 'viewer',
      scope: 'read',
    });
  }

  private async requireWriteAccess(
    connection: Connection,
    principal: Principal,
    projectId: string,
  ): Promise<void> {
    await requireProject(connection, principal, {
      projectId,
      role: 'editor',
      scope: 'registry:write',
    });
  }
}
