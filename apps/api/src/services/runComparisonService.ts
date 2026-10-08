import {
  DEFAULT_SERIES_POINTS,
  MAX_SERIES_KEYS,
  type ComparedDatasetVersion,
  type ComparedModelVersion,
  type MetricSeries,
  type RunComparison,
} from '@mmt/contracts';
import type { Principal } from '../auth/principal.js';
import type { Database } from '../db/database.js';
import { notFound } from '../domain/errors.js';
import { MAX_RESPONSE_POINTS } from '../domain/metricSeries/metricSeriesValidation.js';
import { buildComparisonRows } from '../domain/runComparisonRows.js';
import { readComparedRuns, type ComparedRun } from '../repositories/runComparisonRepository.js';
import { requireProject } from './accessService.js';
import type { MetricSeriesService } from './metricSeriesService.js';

/** A validated comparison request; baselineRunId is one of runIds. */
export interface RunComparisonQuery {
  runIds: string[];
  baselineRunId: string | null;
  metricKeys: string[] | null;
  includeHistory: boolean;
}

// Several Runs often share one evaluation DatasetVersion or ModelVersion; list each once.
function uniqueById<T extends { id: string }>(items: T[]): T[] {
  return [...new Map(items.map((item) => [item.id, item])).values()];
}

function inRequestOrder(found: ComparedRun[], runIds: string[]): ComparedRun[] {
  // Another Project's Run is reported like a missing one so its existence does not leak.
  if (found.length !== runIds.length) notFound('Run');
  const foundById = new Map(found.map((compared) => [compared.run.id, compared]));
  return runIds.map((id) => foundById.get(id)!);
}

export class RunComparisonService {
  constructor(
    private readonly database: Database,
    private readonly metricSeries: MetricSeriesService,
  ) {}

  async compare(
    principal: Principal,
    projectId: string,
    query: RunComparisonQuery,
  ): Promise<RunComparison> {
    await requireProject(this.database, principal, {
      projectId,
      role: 'viewer',
      scope: 'read',
    });
    const compared = inRequestOrder(
      await readComparedRuns(this.database, {
        projectId,
        runIds: query.runIds,
      }),
      query.runIds,
    );
    const runs = compared.map((item) => item.run);
    const rows = buildComparisonRows({
      runs,
      baselineRunId: query.baselineRunId,
      metricKeys: query.metricKeys,
    });
    const comparison: RunComparison = {
      runs,
      baselineRunId: query.baselineRunId,
      datasetVersions: uniqueById<ComparedDatasetVersion>(
        compared.flatMap((item) => item.datasetVersions),
      ),
      modelVersions: uniqueById<ComparedModelVersion>(
        compared.flatMap((item) => (item.modelVersion ? [item.modelVersion] : [])),
      ),
      rows,
    };
    if (!query.includeHistory) return comparison;
    const historyKeys = rows
      .filter((row) => row.namespace === 'metrics')
      .slice(0, MAX_SERIES_KEYS)
      .map((row) => row.key);
    return {
      ...comparison,
      history: await this.readHistory(principal, projectId, {
        runIds: query.runIds,
        keys: historyKeys,
      }),
    };
  }

  private async readHistory(
    principal: Principal,
    projectId: string,
    selection: { runIds: string[]; keys: string[] },
  ): Promise<MetricSeries[]> {
    const { runIds, keys } = selection;
    if (!keys.length) return [];
    // 50 Runs x 50 keys at the default density would exceed the series response limit.
    const maxPoints = Math.min(
      DEFAULT_SERIES_POINTS,
      Math.floor(MAX_RESPONSE_POINTS / (runIds.length * keys.length)),
    );
    const response = await this.metricSeries.readSeries(principal, projectId, {
      runIds,
      keys,
      xAxis: { kind: 'step' },
      maxPoints,
      xRange: null,
    });
    return response.series;
  }
}
