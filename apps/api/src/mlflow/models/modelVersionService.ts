import type { Principal } from '../../auth/principal.js';
import { first, type Database, type Connection } from '../../db/database.js';
import { conflict } from '../../domain/errors.js';
import { findRun } from '../../repositories/registryRepository.js';
import { modelAliasActor, removeModelAliases } from '../../repositories/modelAliasRepository.js';
import { mlflowAliasGuard } from '../../services/aliasProtectionService.js';
import type { RegistryService } from '../../services/registryService.js';
import { uuidSchema } from '../../domain/validation.js';
import { parse } from '../../http/request.js';
import { requireModelsRead } from './access.js';
import { mutateRegisteredModel } from './modelMutation.js';
import { activeModelVersions, findModelVersion, findRegisteredModel } from './modelRepository.js';
import { selectPrimaryModelArtifact } from './modelManifest.js';
import { resolveRegistrationSource } from './registrationSource.js';
import { modelVersionProtocol, latestVersions } from './protocol.js';
import { invalidParameter, keyValueMap, type CreateModelVersion } from './validation.js';
import type { ModelReference, ModelVersionRecord } from './types.js';

import { MAX_MODEL_NAME_LENGTH } from './limits.js';

export class ModelVersionService {
  constructor(
    private readonly database: Database,
    private readonly registry: RegistryService,
  ) {}

  async create(principal: Principal, projectId: string, input: CreateModelVersion) {
    return mutateRegisteredModel(
      this.database,
      { principal, projectId, name: input.name },
      async (connection, model) => {
        const source = await resolveRegistrationSource(connection, { projectId, input });
        if (input.run_id && input.run_id !== source.sourceRunId)
          conflict('run_idと保存済みモデルのsource Runが一致しません');
        const tags = { ...model.tags, ...source.tags, ...keyValueMap(input.tags) };
        const requestedFamily = tags['mmt.model_family'];
        if (
          requestedFamily !== undefined &&
          (!requestedFamily || requestedFamily.length > MAX_MODEL_NAME_LENGTH)
        )
          invalidParameter('mmt.model_familyが不正です');
        if (requestedFamily && requestedFamily !== model.family) {
          const existing = await first<{ present: boolean }>(
            connection,
            'SELECT EXISTS(SELECT 1 FROM model_versions WHERE model_id=$1) AS present',
            [model.id],
          );
          if (existing?.present || model.tags['mmt.model_family'] || model.family !== 'mlflow')
            conflict('mmt.model_familyがnative Modelの系列と一致しません');
          await connection.query('UPDATE models SET family=$2 WHERE id=$1', [
            model.id,
            requestedFamily,
          ]);
        }
        const primary = selectPrimaryModelArtifact(source, tags);
        const codeVersionId =
          tags['mmt.code_version_id'] !== undefined
            ? parse(uuidSchema, tags['mmt.code_version_id'])
            : source.defaultCodeVersionId;
        const sourceRun = source.sourceRunId
          ? await findRun(connection, { projectId, id: source.sourceRunId })
          : null;
        const parents = [
          ...new Set([
            ...source.parentModelVersionIds,
            ...(sourceRun?.modelVersionId ? [sourceRun.modelVersionId] : []),
          ]),
        ];
        const version = await this.registry.registerModelVersion(connection, {
          projectId,
          modelId: model.id,
          sourceRunId: source.sourceRunId,
          parentVersionIds: parents,
          weightsUri: `/api/projects/${projectId}/artifacts/${primary.artifact.artifactId}/content`,
          artifactId: primary.artifact.artifactId,
          defaultCodeVersionId: codeVersionId,
          metadata: {
            mlflow: {
              loggedModelId: source.loggedModelId,
              artifactUri: source.artifactUri,
              primaryArtifactPath: primary.artifact.path,
              ...(primary.modelFormat === 'mlflow'
                ? { modelFormat: 'mlflow' }
                : { weightsPath: primary.artifact.path }),
              artifactManifest: source.manifest.map((entry) => ({ ...entry })),
              loggedModelMetadata: source.metadata,
            },
          },
          actor: { type: 'principal', principal },
        });
        await connection.query(
          `INSERT INTO mlflow_model_version_metadata(version_id,project_id,logged_model_id,artifact_uri,tags,description,run_link)
        VALUES($1,$2,$3,$4,$5,$6,$7)`,
          [
            version.id,
            projectId,
            source.loggedModelId,
            `mlflow-artifacts:/model-versions/${version.id}/artifacts`,
            JSON.stringify(tags),
            input.description,
            input.run_link,
          ],
        );
        return modelVersionProtocol(
          await findModelVersion(connection, {
            projectId,
            name: model.name,
            version: version.version,
          }),
        );
      },
    );
  }

  async get(principal: Principal, projectId: string, reference: ModelReference) {
    await requireModelsRead(this.database, { principal, projectId });
    return modelVersionProtocol(await findModelVersion(this.database, { projectId, ...reference }));
  }

  async downloadUri(
    principal: Principal,
    projectId: string,
    reference: ModelReference,
  ): Promise<string> {
    await requireModelsRead(this.database, { principal, projectId });
    const version = await findModelVersion(this.database, { projectId, ...reference });
    if (!version.artifactUri)
      invalidParameter('このnativeモデルバージョンにはMLflowモデル一式がありません');
    return version.artifactUri;
  }

  async latest(
    principal: Principal,
    projectId: string,
    reference: { name: string; stages?: string[] },
  ) {
    await requireModelsRead(this.database, { principal, projectId });
    const model = await findRegisteredModel(this.database, { projectId, name: reference.name });
    return latestVersions(
      await activeModelVersions(this.database, { projectId, id: model.id }),
      reference.stages,
    ).map(modelVersionProtocol);
  }

  async update(
    principal: Principal,
    projectId: string,
    reference: ModelReference & { description?: string },
  ) {
    return mutateRegisteredModel(
      this.database,
      { principal, projectId, name: reference.name },
      async (connection) => {
        const version = await findModelVersion(connection, { projectId, ...reference });
        await this.ensureMetadata(connection, version);
        if (reference.description !== undefined)
          await connection.query(
            'UPDATE mlflow_model_version_metadata SET description=$2,updated_at=now() WHERE version_id=$1',
            [version.id, reference.description],
          );
        return modelVersionProtocol(
          await findModelVersion(connection, { projectId, ...reference }),
        );
      },
    );
  }

  async delete(principal: Principal, projectId: string, reference: ModelReference): Promise<void> {
    await mutateRegisteredModel(
      this.database,
      { principal, projectId, name: reference.name },
      async (connection) => {
        const version = await findModelVersion(connection, { projectId, ...reference });
        await this.ensureMetadata(connection, version);
        await connection.query(
          'UPDATE mlflow_model_version_metadata SET deleted_at=now(),updated_at=now() WHERE version_id=$1',
          [version.id],
        );
        await removeModelAliases(connection, {
          modelId: version.modelId,
          versionId: version.id,
          actor: modelAliasActor(principal),
          source: 'version_deleted',
          guard: mlflowAliasGuard,
        });
      },
    );
  }

  async setTag(
    principal: Principal,
    projectId: string,
    reference: ModelReference & { key: string; value?: string },
  ): Promise<void> {
    await mutateRegisteredModel(
      this.database,
      { principal, projectId, name: reference.name },
      async (connection) => {
        const version = await findModelVersion(connection, { projectId, ...reference });
        // Execution configuration was fixed at native registration; tags cannot change it later.
        if (
          ['mmt.model_family', 'mmt.code_version_id', 'mmt.weights_path'].includes(reference.key)
        ) {
          if (reference.value !== version.tags[reference.key])
            conflict('登録済みバージョンの実行設定tagは変更できません');
          return;
        }
        await this.ensureMetadata(connection, version);
        if (reference.value === undefined)
          await connection.query(
            'UPDATE mlflow_model_version_metadata SET tags=tags-$2::text,updated_at=now() WHERE version_id=$1',
            [version.id, reference.key],
          );
        else
          await connection.query(
            'UPDATE mlflow_model_version_metadata SET tags=tags || $2::jsonb,updated_at=now() WHERE version_id=$1',
            [version.id, JSON.stringify({ [reference.key]: reference.value })],
          );
      },
    );
  }

  async transitionStage(
    principal: Principal,
    projectId: string,
    reference: ModelReference & { stage: string; archive_existing_versions: boolean },
  ) {
    return mutateRegisteredModel(
      this.database,
      { principal, projectId, name: reference.name },
      async (connection, model) => {
        const version = await findModelVersion(connection, { projectId, ...reference });
        await this.ensureMetadata(connection, version);
        if (reference.archive_existing_versions) {
          if (!['Staging', 'Production'].includes(reference.stage))
            invalidParameter('archive_existing_versionsはStaging/Productionに指定してください');
          await connection.query(
            `UPDATE mlflow_model_version_metadata vm SET current_stage='Archived',updated_at=now()
          FROM model_versions v WHERE v.id=vm.version_id AND v.model_id=$1 AND vm.current_stage=$2 AND vm.version_id<>$3 AND vm.deleted_at IS NULL`,
            [model.id, reference.stage, version.id],
          );
        }
        await connection.query(
          'UPDATE mlflow_model_version_metadata SET current_stage=$2,updated_at=now() WHERE version_id=$1',
          [version.id, reference.stage],
        );
        return modelVersionProtocol(
          await findModelVersion(connection, { projectId, ...reference }),
        );
      },
    );
  }

  private async ensureMetadata(connection: Connection, version: ModelVersionRecord): Promise<void> {
    await connection.query(
      `INSERT INTO mlflow_model_version_metadata(version_id,project_id,artifact_uri) VALUES($1,$2,$3) ON CONFLICT(version_id) DO NOTHING`,
      [version.id, version.projectId, version.artifactUri ?? ''],
    );
  }
}
