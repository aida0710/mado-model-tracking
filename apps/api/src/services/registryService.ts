import type {
  Code,
  CodeVersion,
  Dataset,
  DatasetVersion,
  Model,
  ModelVersion,
  Run,
} from '@mmt/contracts';
import type { Principal } from '../auth/principal.js';
import { first, rows, transaction, type Database, type Connection } from '../db/database.js';
import type {
  CodeVersionCreate,
  DatasetVersionCreate,
  ModelVersionCreate,
} from '../domain/validation.js';
import { validateCodeCompatibility } from '../domain/compatibility.js';
import { conflict, notFound } from '../domain/errors.js';
import { isTerminalStatus } from '../domain/runTransitions.js';
import {
  assertProjectReference,
  assertProjectReferences,
  codeSelect,
  datasetSelect,
  datasetVersionSelect,
  findCodeVersion,
  findRun,
  modelSelect,
  modelVersionSelect,
} from '../repositories/registryRepository.js';
import { requireProject } from './accessService.js';
import { enqueueRunEvent } from './outboxEvents.js';

export class RegistryService {
  constructor(private readonly database: Database) {}

  async models(principal: Principal, projectId: string): Promise<Model[]> {
    await this.requireReadAccess(principal, projectId);
    return rows(this.database, `${modelSelect} WHERE m.project_id=$1 ORDER BY m.created_at DESC`, [
      projectId,
    ]);
  }

  async createModel(
    principal: Principal,
    projectId: string,
    input: { name: string; family: string; description: string },
  ): Promise<Model> {
    await this.requireWriteAccess(this.database, principal, projectId);
    const model = (await first<Omit<Model, 'latestVersion' | 'aliases'>>(
      this.database,
      'INSERT INTO models(project_id,name,family,description) VALUES($1,$2,$3,$4) RETURNING *',
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
    return transaction(this.database, async (connection) => {
      await this.requireWriteAccess(connection, principal, projectId);
      const model = await first<Model>(
        connection,
        'SELECT * FROM models WHERE id=$1 AND project_id=$2',
        [registration.modelId, projectId],
      );
      if (!model) notFound('Model');
      const input = registration.input;
      await assertProjectReferences(connection, {
        table: 'model_versions',
        projectId,
        ids: input.parentModelVersionIds,
      });
      if (input.sourceRunId) await findRun(connection, { projectId, id: input.sourceRunId });
      if (input.artifactId)
        await assertProjectReference(connection, {
          table: 'artifacts',
          projectId,
          id: input.artifactId,
        });
      if (input.defaultCodeVersionId)
        validateCodeCompatibility(
          await findCodeVersion(connection, {
            projectId,
            id: input.defaultCodeVersionId,
          }),
          { model },
        );
      const version = (await first<Omit<ModelVersion, 'family'>>(
        connection,
        `INSERT INTO model_versions(model_id,project_id,version,source_run_id,parent_model_version_ids,weights_uri,artifact_id,default_code_version_id,metadata)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [
          model.id,
          projectId,
          input.version,
          input.sourceRunId ?? null,
          input.parentModelVersionIds,
          input.weightsUri ?? null,
          input.artifactId ?? null,
          input.defaultCodeVersionId ?? null,
          JSON.stringify(input.metadata),
        ],
      ))!;
      return { ...version, family: model.family };
    });
  }

  async setAlias(
    principal: Principal,
    projectId: string,
    registration: { modelId: string; alias: string; versionId: string },
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
      await connection.query(
        'INSERT INTO model_aliases(model_id,alias,version_id) VALUES($1,$2,$3) ON CONFLICT(model_id,alias) DO UPDATE SET version_id=EXCLUDED.version_id',
        [registration.modelId, registration.alias, registration.versionId],
      );
      return (await first<Model>(connection, `${modelSelect} WHERE m.id=$1`, [
        registration.modelId,
      ]))!;
    });
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
      if (input.source.kind === 'artifact')
        await assertProjectReference(connection, {
          table: 'artifacts',
          projectId,
          id: input.source.artifactId,
        });
      return (await first<CodeVersion>(
        connection,
        `INSERT INTO code_versions(code_id,project_id,version,source,entrypoint,requirements,environment,supported_model_families,task_types)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [
          registration.codeId,
          projectId,
          input.version,
          JSON.stringify(input.source),
          input.entrypoint,
          input.requirements,
          JSON.stringify(input.environment),
          input.supportedModelFamilies,
          input.taskTypes,
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

  async createDatasetVersion(
    principal: Principal,
    projectId: string,
    registration: { datasetId: string; input: DatasetVersionCreate },
  ): Promise<DatasetVersion> {
    return transaction(this.database, async (connection) => {
      await this.requireWriteAccess(connection, principal, projectId);
      return this.insertDatasetVersion(connection, projectId, registration);
    });
  }

  async insertDatasetVersion(
    connection: Connection,
    projectId: string,
    registration: { datasetId: string; input: DatasetVersionCreate },
  ): Promise<DatasetVersion> {
    const dataset = await first<Dataset>(
      connection,
      'SELECT * FROM datasets WHERE id=$1 AND project_id=$2',
      [registration.datasetId, projectId],
    );
    if (!dataset) notFound('Dataset');
    const input = registration.input;
    await assertProjectReferences(connection, {
      table: 'dataset_versions',
      projectId,
      ids: input.parentDatasetVersionIds,
    });
    const sourceRun = input.sourceRunId
      ? await findRun(connection, {
          projectId,
          id: input.sourceRunId,
          lock: true,
        })
      : null;
    if (input.externalRef) {
      await assertProjectReference(connection, {
        table: 'plugin_connections',
        projectId,
        id: input.externalRef.pluginId,
      });
      if (
        input.externalRef.version !== input.version ||
        input.externalRef.name !== dataset.name ||
        input.externalRef.namespace !== dataset.namespace
      )
        conflict('External datasetの参照が登録する版と一致しません');
    }
    const version = (await first<Omit<DatasetVersion, 'name' | 'namespace'>>(
      connection,
      `INSERT INTO dataset_versions(dataset_id,project_id,version,uri,digest,schema,metadata,source_run_id,parent_dataset_version_ids,external_ref)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [
        dataset.id,
        projectId,
        input.version,
        input.uri,
        input.digest,
        JSON.stringify(input.schema),
        JSON.stringify(input.metadata),
        input.sourceRunId ?? null,
        input.parentDatasetVersionIds,
        input.externalRef ? JSON.stringify(input.externalRef) : null,
      ],
    ))!;
    if (sourceRun) {
      const updatedRun = await first<Run>(
        connection,
        'UPDATE runs SET output_dataset_version_ids=array_append(output_dataset_version_ids,$2::uuid) WHERE id=$1 RETURNING *',
        [sourceRun.id, version.id],
      );
      // A late registration must refresh external lineage in the same transaction.
      if (updatedRun && isTerminalStatus(updatedRun.status))
        await enqueueRunEvent(connection, updatedRun);
    }
    return { ...version, name: dataset.name, namespace: dataset.namespace };
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
