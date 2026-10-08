import type { Run, RunKind, RunSearchPage, RunStatus } from '@mmt/contracts';
import type { PoolClient } from 'pg';
import type { Principal } from '../auth/principal.js';
import { first, rows, transaction, type Database } from '../db/database.js';
import { DomainError } from '../domain/errors.js';
import { compileSearchExpression } from '../domain/runSearch/runSearchCompiler.js';
import {
  decodeRunSearchCursor,
  encodeRunSearchCursor,
  runSearchConditionsFingerprint,
  type RunSearchCursor,
} from '../domain/runSearch/runSearchPage.js';
import { runSummarySelect } from '../repositories/runListProjection.js';
import { assertProjectReference } from '../repositories/registryRepository.js';
import { requireProject } from './accessService.js';

/** A validated search request; absent list conditions are empty and absent values null. */
export interface RunSearchQuery {
  experimentIds: string[];
  filter: string;
  orderBy: string[];
  kinds: RunKind[];
  statuses: RunStatus[];
  modelVersionIds: string[];
  inputDatasetVersionIds: string[];
  parentRunId: string | null;
  name: string | null;
  limit: number;
  cursor: string | null;
}
type RunSearchConditions = Omit<RunSearchQuery, 'limit' | 'cursor'>;

// Matches the partial index of migration 020, so the newest-first keyset reads it directly.
const CREATION_ORDER = 'r.created_at DESC,r.id DESC';

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

// Sorting set-like conditions keeps a cursor valid when a client reorders the same filter values.
function normalizeConditions(query: RunSearchQuery): RunSearchConditions {
  const sortedUnique = <T extends string>(values: T[]) => [...new Set(values)].sort();
  return {
    experimentIds: sortedUnique(query.experimentIds),
    filter: query.filter.trim(),
    orderBy: query.orderBy.map((order) => order.trim()),
    kinds: sortedUnique(query.kinds),
    statuses: sortedUnique(query.statuses),
    modelVersionIds: sortedUnique(query.modelVersionIds),
    inputDatasetVersionIds: sortedUnique(query.inputDatasetVersionIds),
    parentRunId: query.parentRunId,
    name: query.name,
  };
}

export class RunSearchService {
  constructor(private readonly database: Database) {}

  async search(
    principal: Principal,
    projectId: string,
    query: RunSearchQuery,
  ): Promise<RunSearchPage> {
    await requireProject(this.database, principal, { projectId, role: 'viewer', scope: 'read' });
    const conditions = normalizeConditions(query);
    for (const id of conditions.experimentIds)
      await assertProjectReference(this.database, { table: 'experiments', projectId, id });
    const fingerprint = runSearchConditionsFingerprint({ projectId, ...conditions });
    const mode = conditions.orderBy.length ? 'offset' : 'keyset';
    const cursor = query.cursor ? decodeRunSearchCursor(query.cursor, { fingerprint, mode }) : null;
    // Both reads see one snapshot so a Run deleted between them cannot leave a hole in the page.
    return transaction(this.database, async (connection) => {
      await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const runIds = await this.findPageRunIds(connection, {
        projectId,
        conditions,
        cursor,
        limit: query.limit,
      });
      const pageRunIds = runIds.slice(0, query.limit);
      const items = await this.readSummaries(connection, { projectId, runIds: pageRunIds });
      const hasMore = runIds.length > query.limit;
      const nextCursor: RunSearchCursor | null = !hasMore
        ? null
        : mode === 'keyset'
          ? { mode, afterRunId: pageRunIds.at(-1)! }
          : { mode, offset: (cursor?.mode === 'offset' ? cursor.offset : 0) + query.limit };
      return {
        items,
        nextCursor: nextCursor && encodeRunSearchCursor(nextCursor, fingerprint),
      };
    });
  }

  private async findPageRunIds(
    connection: PoolClient,
    page: {
      projectId: string;
      conditions: RunSearchConditions;
      cursor: RunSearchCursor | null;
      limit: number;
    },
  ): Promise<string[]> {
    const { projectId, conditions, cursor } = page;
    const search = compileSearchExpression(
      'run',
      { filter: conditions.filter, orderBy: conditions.orderBy },
      [projectId],
    );
    const bind = (value: unknown) => `$${search.parameters.push(value)}`;
    const where = ['r.project_id=$1', "r.lifecycle_stage='active'", search.filter];
    if (conditions.experimentIds.length)
      where.push(`r.experiment_id=ANY(${bind(conditions.experimentIds)}::uuid[])`);
    if (conditions.kinds.length) where.push(`r.kind=ANY(${bind(conditions.kinds)}::text[])`);
    if (conditions.statuses.length)
      where.push(`r.status=ANY(${bind(conditions.statuses)}::text[])`);
    if (conditions.modelVersionIds.length)
      where.push(`r.model_version_id=ANY(${bind(conditions.modelVersionIds)}::uuid[])`);
    if (conditions.inputDatasetVersionIds.length)
      where.push(
        `r.input_dataset_version_ids && ${bind(conditions.inputDatasetVersionIds)}::uuid[]`,
      );
    if (conditions.parentRunId) where.push(`r.parent_run_id=${bind(conditions.parentRunId)}`);
    if (conditions.name)
      where.push(`r.name ILIKE '%'||${bind(escapeLikePattern(conditions.name))}||'%'`);
    if (cursor?.mode === 'keyset') {
      const after = await first(connection, 'SELECT 1 FROM runs WHERE project_id=$1 AND id=$2', [
        projectId,
        cursor.afterRunId,
      ]);
      if (!after) throw new DomainError(400, 'cursorのRunが見つかりません', 'invalid_cursor');
      where.push(
        `(r.created_at,r.id) < (SELECT c.created_at,c.id FROM runs c WHERE c.project_id=$1 AND c.id=${bind(cursor.afterRunId)})`,
      );
    }
    const orderBy = conditions.orderBy.length ? search.orderBy : CREATION_ORDER;
    const limit = bind(page.limit + 1);
    const offset = bind(cursor?.mode === 'offset' ? cursor.offset : 0);
    const found = await rows<{ id: string }>(
      connection,
      `SELECT r.id FROM runs r WHERE ${where.join(' AND ')} ORDER BY ${orderBy} LIMIT ${limit} OFFSET ${offset}`,
      search.parameters,
    );
    return found.map((run) => run.id);
  }

  private async readSummaries(
    connection: PoolClient,
    page: { projectId: string; runIds: string[] },
  ): Promise<Run[]> {
    if (!page.runIds.length) return [];
    const summaries = await rows<Run>(
      connection,
      `${runSummarySelect} WHERE project_id=$1 AND id=ANY($2::uuid[])`,
      [page.projectId, page.runIds],
    );
    const summariesById = new Map(summaries.map((run) => [run.id, run]));
    return page.runIds.map((id) => summariesById.get(id)!);
  }
}
