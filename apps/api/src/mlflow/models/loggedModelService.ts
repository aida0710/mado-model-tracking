import { randomUUID } from 'node:crypto';
import type { Principal } from '../../auth/principal.js';
import { first, rows, transaction, type Database, type Connection } from '../../db/database.js';
import { conflict, notFound } from '../../domain/errors.js';
import { assertProjectReference, findRun } from '../../repositories/registryRepository.js';
import { requireModelsRead, requireModelsWrite } from './access.js';
import { mutateLoggedModel } from './modelMutation.js';
import { modelExperimentId } from './experimentReference.js';
import { findLoggedModel, loggedModelMetrics } from './modelRepository.js';
import { loggedModelProtocol } from './protocol.js';
import { loggedModelArtifacts } from './modelArtifactRepository.js';
import { validateReadyModel } from './modelManifest.js';
import { loggedModelSearch } from './loggedModelSearch.js';
import { nextPageToken, pageOffset, searchFingerprint } from './searchSyntax.js';
import { keyValueMap, type CreateLoggedModel, type SearchLoggedModels } from './validation.js';
import type { LoggedModelRecord, LoggedModelStatus } from './types.js';

export class LoggedModelService {
  constructor(private readonly database: Database) {}

  async create(principal: Principal, projectId: string, input: CreateLoggedModel) {
    const model = await transaction(this.database, async (connection) => {
      await requireModelsWrite(connection, { principal, projectId });
      if (input.experiment_id === '0') {
        // Match Tracking's create-run flow for a new Project with no Default Experiment yet.
        await connection.query(
          "INSERT INTO experiments(project_id,name) VALUES($1,'Default') ON CONFLICT(project_id,name) DO NOTHING",
          [projectId],
        );
      }
      const experimentId = await modelExperimentId(connection, {
        projectId,
        id: input.experiment_id,
      });
      await assertProjectReference(connection, {
        table: 'experiments',
        projectId,
        id: experimentId,
      });
      if (
        !(await first(
          connection,
          "SELECT id FROM experiments WHERE project_id=$1 AND id=$2 AND lifecycle_stage='active' FOR SHARE",
          [projectId, experimentId],
        ))
      )
        notFound('Experiment');
      if (input.source_run_id) {
        const run = await findRun(connection, { projectId, id: input.source_run_id });
        if (
          !(await first(
            connection,
            "SELECT id FROM runs WHERE project_id=$1 AND id=$2 AND lifecycle_stage='active' FOR KEY SHARE",
            [projectId, run.id],
          ))
        )
          notFound('Run');
        if (run.experimentId !== experimentId)
          conflict('source RunとモデルのExperimentが一致しません');
      }
      const id = `m-${randomUUID().replaceAll('-', '')}`;
      return (await first<LoggedModelRecord>(
        connection,
        `INSERT INTO mlflow_logged_models(
        id,project_id,experiment_id,source_run_id,name,model_type,params,tags,created_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [
          id,
          projectId,
          experimentId,
          input.source_run_id ?? null,
          input.name ?? id,
          input.model_type ?? null,
          JSON.stringify(keyValueMap(input.params)),
          JSON.stringify(keyValueMap(input.tags)),
          principal.user.id,
        ],
      ))!;
    });
    return loggedModelProtocol(model);
  }

  async get(
    principal: Principal,
    projectId: string,
    reference: { id: string; allowDeleted?: boolean },
  ) {
    await requireModelsRead(this.database, { principal, projectId });
    const model = await findLoggedModel(this.database, { projectId, ...reference });
    return this.protocol(this.database, model);
  }

  async finalize(
    principal: Principal,
    projectId: string,
    input: { id: string; status: LoggedModelStatus },
  ) {
    if (input.status === 'PENDING') conflict('finalizeにはREADYまたはFAILEDを指定してください');
    return mutateLoggedModel(
      this.database,
      { principal, projectId, id: input.id },
      async (connection, model) => {
        if (model.status === input.status) return this.protocol(connection, model);
        if (model.status !== 'PENDING') conflict('確定済みモデルのstatusは変更できません');
        if (input.status === 'READY')
          validateReadyModel(await loggedModelArtifacts(connection, model));
        const updated = (await first<LoggedModelRecord>(
          connection,
          'UPDATE mlflow_logged_models SET status=$3,updated_at=now() WHERE project_id=$1 AND id=$2 RETURNING *',
          [projectId, model.id, input.status],
        ))!;
        return this.protocol(connection, updated);
      },
    );
  }

  async delete(principal: Principal, projectId: string, id: string): Promise<void> {
    await mutateLoggedModel(
      this.database,
      { principal, projectId, id },
      async (connection, model) => {
        // Existing immutable model versions retain their snapshots and artifacts.
        await connection.query(
          'UPDATE mlflow_logged_models SET deleted_at=now(),updated_at=now() WHERE id=$1',
          [model.id],
        );
      },
    );
  }

  async setTags(
    principal: Principal,
    projectId: string,
    input: { id: string; tags: { key: string; value: string }[] },
  ) {
    return mutateLoggedModel(
      this.database,
      { principal, projectId, id: input.id },
      async (connection, model) => {
        const updated = (await first<LoggedModelRecord>(
          connection,
          'UPDATE mlflow_logged_models SET tags=tags || $2::jsonb,updated_at=now() WHERE id=$1 RETURNING *',
          [model.id, JSON.stringify(keyValueMap(input.tags))],
        ))!;
        return this.protocol(connection, updated);
      },
    );
  }

  async deleteTag(
    principal: Principal,
    projectId: string,
    input: { id: string; key: string },
  ): Promise<void> {
    await mutateLoggedModel(
      this.database,
      { principal, projectId, id: input.id },
      async (connection) => {
        await connection.query(
          'UPDATE mlflow_logged_models SET tags=tags-$2::text,updated_at=now() WHERE id=$1',
          [input.id, input.key],
        );
      },
    );
  }

  async logParams(
    principal: Principal,
    projectId: string,
    input: { id: string; params: { key: string; value: string }[] },
  ): Promise<void> {
    await mutateLoggedModel(
      this.database,
      { principal, projectId, id: input.id },
      async (connection, model) => {
        const params = keyValueMap(input.params);
        for (const [key, value] of Object.entries(params)) {
          if (Object.hasOwn(model.params, key) && model.params[key] !== value)
            conflict('記録済みモデルparamは変更できません');
        }
        await connection.query(
          'UPDATE mlflow_logged_models SET params=params || $2::jsonb,updated_at=now() WHERE id=$1',
          [input.id, JSON.stringify(params)],
        );
      },
    );
  }

  async search(principal: Principal, projectId: string, input: SearchLoggedModels) {
    await requireModelsRead(this.database, { principal, projectId });
    const experimentIds: string[] = [];
    for (const experimentId of new Set(input.experiment_ids)) {
      const id = await modelExperimentId(this.database, { projectId, id: experimentId });
      experimentIds.push(id);
      await assertProjectReference(this.database, { table: 'experiments', projectId, id });
    }
    const fingerprint = searchFingerprint({ projectId, ...input, page_token: undefined });
    const offset = pageOffset(input.page_token, fingerprint);
    const search = loggedModelSearch({ ...input, experiment_ids: experimentIds }, projectId);
    const limit = search.parameters.add(input.max_results + 1);
    const start = search.parameters.add(offset);
    const matches = await rows<LoggedModelRecord>(
      this.database,
      `SELECT l.* FROM mlflow_logged_models l JOIN experiments e ON e.id=l.experiment_id AND e.project_id=l.project_id WHERE l.project_id=$1 AND l.experiment_id=ANY($2::uuid[]) AND l.deleted_at IS NULL AND e.lifecycle_stage='active' AND ${search.filter} ORDER BY ${search.order} LIMIT ${limit} OFFSET ${start}`,
      search.parameters.values,
    );
    const models = [];
    for (const model of matches.slice(0, input.max_results))
      models.push(await this.protocol(this.database, model));
    return {
      models,
      ...(matches.length > input.max_results
        ? { next_page_token: nextPageToken(offset + input.max_results, fingerprint) }
        : {}),
    };
  }

  private async protocol(connection: Connection, model: LoggedModelRecord) {
    const metrics = await loggedModelMetrics(connection, {
      projectId: model.projectId,
      id: model.id,
    });
    const registrations = await rows<{ name: string; version: string }>(
      connection,
      `SELECT m.name,v.version FROM mlflow_model_version_metadata vm JOIN model_versions v ON v.id=vm.version_id
        JOIN models m ON m.id=v.model_id LEFT JOIN mlflow_registered_model_metadata mm ON mm.model_id=m.id
        WHERE vm.project_id=$1 AND vm.logged_model_id=$2 AND vm.deleted_at IS NULL AND mm.deleted_at IS NULL ORDER BY m.name,v.version`,
      [model.projectId, model.id],
    );
    return loggedModelProtocol(model, metrics, registrations);
  }
}
