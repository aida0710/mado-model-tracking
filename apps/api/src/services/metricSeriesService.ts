import {
  MAX_GROUPED_RUNS,
  MAX_SERIES_GROUPS,
  type MetricGroup,
  type MetricGroupsResponse,
  type MetricSeries,
  type MetricSeriesResponse,
} from '@mmt/contracts';
import type { PoolClient } from 'pg';
import type { Principal } from '../auth/principal.js';
import { transaction, type Database } from '../db/database.js';
import { DomainError, notFound } from '../domain/errors.js';
import {
  MAX_RESPONSE_POINTS,
  type MetricGroupsQuery,
  type MetricSeriesQuery,
} from '../domain/metricSeries/metricSeriesValidation.js';
import { groupRuns } from '../domain/metricSeries/runGrouping.js';
import {
  assembleSeriesPoints,
  planSeriesBuckets,
  planSharedBuckets,
} from '../domain/metricSeries/seriesBuckets.js';
import {
  beginSeriesSnapshot,
  findProjectRunIds,
  isSeriesQueryTimeout,
  readGroupBuckets,
  readKeyExtents,
  readRunGroupValues,
  readSeriesBuckets,
  readSeriesExtents,
  type MetricPointSelection,
} from '../repositories/metricSeriesRepository.js';
import { requireProject } from './accessService.js';
import type { RunSearchService } from './runSearchService.js';

// The largest page run search serves; a search over 1000 Runs needs at most three pages.
const SEARCH_PAGE_SIZE = 500;

const seriesKey = (runId: string, name: string) => `${runId}\u0000${name}`;

// Map.groupBy is ES2024, beyond the ES2023 library of this build.
function groupRowsBy<T>(items: T[], keyOf: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }
  return groups;
}

// Another Project's Run is reported like a missing one so its existence does not leak.
function requireAllRuns(requested: string[], found: string[]): void {
  if (found.length !== requested.length) notFound('Run');
}

export class MetricSeriesService {
  constructor(
    private readonly database: Database,
    private readonly runSearch: RunSearchService,
  ) {}

  async readSeries(
    principal: Principal,
    projectId: string,
    query: MetricSeriesQuery,
  ): Promise<MetricSeriesResponse> {
    await requireProject(this.database, principal, { projectId, role: 'viewer', scope: 'read' });
    const selection: MetricPointSelection = {
      runIds: query.runIds,
      keys: query.keys,
      xAxis: query.xAxis,
      xRange: query.xRange,
    };
    return this.inSeriesSnapshot(async (connection) => {
      const found = await findProjectRunIds(connection, { projectId, runIds: query.runIds });
      requireAllRuns(query.runIds, found);
      const extents = await readSeriesExtents(connection, selection);
      const plans = extents.flatMap((extent) => {
        const plan = planSeriesBuckets(extent, query);
        return plan ? [{ runId: extent.runId, name: extent.name, plan }] : [];
      });
      const bucketRows = await readSeriesBuckets(connection, { selection, plans });
      const extentsBySeries = new Map(
        extents.map((extent) => [seriesKey(extent.runId, extent.name), extent]),
      );
      const sampledSeries = new Set(
        plans
          .filter((series) => series.plan.kind === 'buckets')
          .map((series) => seriesKey(series.runId, series.name)),
      );
      const rowsBySeries = groupRowsBy(bucketRows, (row) => seriesKey(row.runId, row.name));
      const series = query.runIds.flatMap((runId) =>
        query.keys.map((key): MetricSeries => {
          const id = seriesKey(runId, key);
          const extent = extentsBySeries.get(id);
          const { points, nanCount } = assembleSeriesPoints(rowsBySeries.get(id) ?? []);
          return {
            runId,
            key,
            points,
            sampled: sampledSeries.has(id),
            totalPoints: extent?.totalPoints ?? 0,
            nanCount,
            droppedPoints: extent?.droppedPoints ?? 0,
          };
        }),
      );
      return { series };
    });
  }

  async readGroups(
    principal: Principal,
    projectId: string,
    query: MetricGroupsQuery,
  ): Promise<MetricGroupsResponse> {
    await requireProject(this.database, principal, { projectId, role: 'viewer', scope: 'read' });
    const runIds = query.runIds ?? (await this.searchRunIds(principal, projectId, query.search!));
    if (!runIds.length) return { groups: [] };
    return this.inSeriesSnapshot(async (connection) => {
      const values = await readRunGroupValues(connection, {
        projectId,
        runIds,
        groupBy: query.groupBy,
      });
      requireAllRuns(runIds, values.map((value) => value.runId));
      const valuesByRun = new Map(values.map((value) => [value.runId, value]));
      const assignments = groupRuns(runIds.map((runId) => valuesByRun.get(runId)!));
      if (assignments.length > MAX_SERIES_GROUPS)
        throw new DomainError(
          422,
          `グループが${MAX_SERIES_GROUPS}件を超えています`,
          'too_many_groups',
        );
      if (assignments.length * query.keys.length * query.maxPoints > MAX_RESPONSE_POINTS)
        throw new DomainError(
          422,
          '応答の点数が上限を超えます。maxPointsかkeysを減らしてください',
          'too_many_points',
        );
      const selection: MetricPointSelection = {
        runIds,
        keys: query.keys,
        xAxis: query.xAxis,
        xRange: query.xRange,
      };
      const plans = (await readKeyExtents(connection, selection)).flatMap((extent) => {
        const plan = planSharedBuckets(extent, query);
        return plan ? [{ name: extent.name, plan }] : [];
      });
      const memberships = assignments.flatMap((group, groupIndex) =>
        group.runIds.map((runId) => ({ runId, groupIndex })),
      );
      const bucketRows = await readGroupBuckets(connection, { selection, plans, memberships });
      const rowsBySeries = groupRowsBy(bucketRows, (row) => `${row.groupIndex}\u0000${row.name}`);
      const groups = assignments.map(
        (group, groupIndex): MetricGroup => ({
          ...group,
          series: query.keys.map((key) => ({
            key,
            points: (rowsBySeries.get(`${groupIndex}\u0000${key}`) ?? []).map((row) => ({
              x: row.x,
              mean: row.mean,
              min: row.minValue,
              max: row.maxValue,
              stddev: row.stddev,
              runCount: row.runCount,
            })),
          })),
        }),
      );
      return { groups };
    });
  }

  private async searchRunIds(
    principal: Principal,
    projectId: string,
    search: NonNullable<MetricGroupsQuery['search']>,
  ): Promise<string[]> {
    const runIds: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await this.runSearch.search(principal, projectId, {
        ...search,
        limit: SEARCH_PAGE_SIZE,
        cursor,
      });
      runIds.push(...page.items.map((run) => run.id));
      if (runIds.length > MAX_GROUPED_RUNS)
        throw new DomainError(
          422,
          `検索に一致するRunが${MAX_GROUPED_RUNS}件を超えています。条件を絞ってください`,
          'too_many_runs',
        );
      cursor = page.nextCursor;
    } while (cursor);
    return runIds;
  }

  private async inSeriesSnapshot<T>(read: (connection: PoolClient) => Promise<T>): Promise<T> {
    try {
      return await transaction(this.database, async (connection) => {
        await beginSeriesSnapshot(connection);
        return read(connection);
      });
    } catch (error) {
      if (isSeriesQueryTimeout(error))
        throw new DomainError(
          503,
          'メトリクスの集計が時間内に終わりませんでした。Runかkeyを減らしてください',
          'series_query_timeout',
        );
      throw error;
    }
  }
}
