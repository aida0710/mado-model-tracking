import type { Principal } from '../../auth/principal.js';
import { first, rows, transaction, type Connection, type Database } from '../../db/database.js';
import { DomainError, conflict, notFound } from '../../domain/errors.js';
import { requireProject } from '../../services/accessService.js';
import { compileSearch, nextPageToken, pageOffset } from './trackingSearch.js';
import type { KeyValue, SearchPage, TrackingExperiment, TrackingSearch } from './trackingTypes.js';
import { invalidParameter, unsupported } from './trackingValidation.js';

export async function resolveExperimentId(
  connection: Connection,
  projectId: string,
  id: string,
): Promise<string> {
  if (id !== '0') return id;
  const experiment = await first<{ id: string }>(
    connection,
    "SELECT id FROM experiments WHERE project_id=$1 AND name='Default'",
    [projectId],
  );
  if (!experiment) notFound('Default Experiment');
  return experiment.id;
}
export async function findTrackingExperiment(
  connection: Connection,
  reference: { projectId: string; id: string; lock?: boolean },
): Promise<TrackingExperiment> {
  const id = await resolveExperimentId(connection, reference.projectId, reference.id);
  const experiment = await first<TrackingExperiment>(
    connection,
    `SELECT * FROM experiments WHERE project_id=$1 AND id=$2 ${reference.lock ? 'FOR UPDATE' : ''}`,
    [reference.projectId, id],
  );
  if (!experiment) notFound('Experiment');
  return experiment;
}

export class ExperimentService {
  constructor(private readonly database: Database) {}

  async create(
    principal: Principal,
    projectId: string,
    input: { name: string; artifact_location?: string; tags: KeyValue[] },
  ): Promise<TrackingExperiment> {
    return transaction(this.database, async (connection) => {
      await requireProject(connection, principal, {
        projectId,
        role: 'editor',
        scope: 'runs:write',
      });
      // The project's configured Artifact store is the sole writer for SDK artifacts.
      if (input.artifact_location !== undefined)
        unsupported('artifact_locationの指定は対応していません');
      const experiment = await first<TrackingExperiment>(
        connection,
        `INSERT INTO experiments(project_id,name,tags) VALUES($1,$2,$3::jsonb)
        ON CONFLICT(project_id,name) DO NOTHING RETURNING *`,
        [
          projectId,
          input.name,
          JSON.stringify(Object.fromEntries(input.tags.map(({ key, value }) => [key, value]))),
        ],
      );
      if (!experiment)
        throw new DomainError(409, '同名Experimentが既に存在します', 'resource_already_exists');
      return experiment;
    });
  }
  async get(principal: Principal, projectId: string, id: string): Promise<TrackingExperiment> {
    await requireProject(this.database, principal, { projectId, role: 'viewer', scope: 'read' });
    return findTrackingExperiment(this.database, { projectId, id });
  }
  async getByName(
    principal: Principal,
    projectId: string,
    name: string,
  ): Promise<TrackingExperiment> {
    await requireProject(this.database, principal, { projectId, role: 'viewer', scope: 'read' });
    const experiment = await first<TrackingExperiment>(
      this.database,
      'SELECT * FROM experiments WHERE project_id=$1 AND name=$2',
      [projectId, name],
    );
    if (!experiment) notFound('Experiment');
    return experiment;
  }
  async search(
    principal: Principal,
    projectId: string,
    input: TrackingSearch & { view_type: number },
  ): Promise<SearchPage<TrackingExperiment>> {
    await requireProject(this.database, principal, { projectId, role: 'viewer', scope: 'read' });
    const query = {
      projectId,
      entity: 'experiment',
      filter: input.filter,
      order_by: input.order_by,
      view_type: input.view_type,
    };
    const offset = pageOffset(input.page_token, query);
    const search = compileSearch('experiment', input, [projectId, input.view_type]);
    const limitIndex = search.parameters.push(input.max_results + 1);
    const offsetIndex = search.parameters.push(offset);
    const experiments = await rows<TrackingExperiment>(
      this.database,
      `SELECT e.* FROM experiments e WHERE e.project_id=$1 AND ($2=3 OR e.lifecycle_stage=CASE WHEN $2=2 THEN 'deleted' ELSE 'active' END)
      AND ${search.filter} ORDER BY ${search.orderBy} LIMIT $${limitIndex} OFFSET $${offsetIndex}`,
      search.parameters,
    );
    const hasMore = experiments.length > input.max_results;
    return {
      items: experiments.slice(0, input.max_results),
      ...(hasMore ? { next_page_token: nextPageToken(offset + input.max_results, query) } : {}),
    };
  }
  async rename(
    principal: Principal,
    projectId: string,
    input: { experiment_id: string; new_name: string },
  ): Promise<void> {
    await this.write(principal, projectId, async (connection) => {
      // Artifact PUT locks Project before Experiment; renames must follow the same order.
      await connection.query('SELECT id FROM projects WHERE id=$1 FOR UPDATE', [projectId]);
      const experiment = await findTrackingExperiment(connection, {
        projectId,
        id: input.experiment_id,
        lock: true,
      });
      if (experiment.lifecycleStage !== 'active')
        invalidParameter('削除済みExperimentは変更できません');
      const duplicate = await first(
        connection,
        'SELECT id FROM experiments WHERE project_id=$1 AND name=$2 AND id<>$3',
        [projectId, input.new_name, experiment.id],
      );
      if (duplicate)
        throw new DomainError(409, '同名Experimentが既に存在します', 'resource_already_exists');
      await connection.query('UPDATE experiments SET name=$2,updated_at=now() WHERE id=$1', [
        experiment.id,
        input.new_name,
      ]);
    });
  }
  async setLifecycle(
    principal: Principal,
    projectId: string,
    input: { experiment_id: string; lifecycleStage: 'active' | 'deleted' },
  ): Promise<void> {
    await this.write(principal, projectId, async (connection) => {
      // Lock the experiment before its runs; creation and input writes acquire this same order.
      const experiment = await findTrackingExperiment(connection, {
        projectId,
        id: input.experiment_id,
        lock: true,
      });
      if (experiment.lifecycleStage === input.lifecycleStage)
        invalidParameter(`Experimentは既に${input.lifecycleStage}です`);
      const runs = await rows<{ id: string }>(
        connection,
        'SELECT id FROM runs WHERE project_id=$1 AND experiment_id=$2 ORDER BY id FOR UPDATE',
        [projectId, experiment.id],
      );
      if (input.lifecycleStage === 'deleted' && runs.length) {
        const managed = await first(
          connection,
          "SELECT id FROM jobs WHERE run_id=ANY($1::uuid[]) AND status NOT IN ('finished','failed','canceled')",
          [runs.map((run) => run.id)],
        );
        if (managed) conflict('実行中のJobを含むExperimentは削除できません');
      }
      await connection.query(
        'UPDATE experiments SET lifecycle_stage=$2,updated_at=now() WHERE id=$1',
        [experiment.id, input.lifecycleStage],
      );
      await connection.query(
        'UPDATE runs SET lifecycle_stage=$3 WHERE project_id=$1 AND experiment_id=$2',
        [projectId, experiment.id, input.lifecycleStage],
      );
    });
  }
  async setTag(
    principal: Principal,
    projectId: string,
    input: { experiment_id: string; key: string; value?: string },
  ): Promise<void> {
    await this.write(principal, projectId, async (connection) => {
      const experiment = await findTrackingExperiment(connection, {
        projectId,
        id: input.experiment_id,
        lock: true,
      });
      if (experiment.lifecycleStage !== 'active')
        invalidParameter('削除済みExperimentは変更できません');
      if (input.value === undefined && !Object.hasOwn(experiment.tags, input.key))
        notFound('Experiment Tag');
      const tags =
        input.value === undefined
          ? { ...experiment.tags }
          : { ...experiment.tags, [input.key]: input.value };
      if (input.value === undefined) delete tags[input.key];
      await connection.query('UPDATE experiments SET tags=$2::jsonb,updated_at=now() WHERE id=$1', [
        experiment.id,
        JSON.stringify(tags),
      ]);
    });
  }
  private async write(
    principal: Principal,
    projectId: string,
    operation: (connection: Connection) => Promise<void>,
  ): Promise<void> {
    await transaction(this.database, async (connection) => {
      await requireProject(connection, principal, {
        projectId,
        role: 'editor',
        scope: 'runs:write',
      });
      await operation(connection);
    });
  }
}
