import {
  DEFAULT_SERIES_POINTS,
  MAX_GROUPED_RUNS,
  MAX_SERIES_RUNS,
  MEDIA_TABLE_PAGE_MAX_ROWS,
  REPORT_SNAPSHOT_BLOCK_MAX_BYTES,
  type ReportChartBlock,
  type ReportEmbedBlock,
  type ReportRunSet,
  type ReportRunTableBlock,
  type ReportScatterBlock,
  type ReportSnapshotData,
  type RunSet,
} from '@mmt/contracts';
import type { Principal } from '../auth/principal.js';
import type { Database } from '../db/database.js';
import { DomainError, notFound } from '../domain/errors.js';
import { MAX_RESPONSE_POINTS } from '../domain/metricSeries/metricSeriesValidation.js';
import { scatterTableKeys } from '../domain/reportBlocks.js';
import { runSearchSchema } from '../routes/runSearchRoutes.js';
import {
  listSweepTrialRunIds,
  readRunNames,
  readRunSummaries,
} from '../repositories/reportRepository.js';
import { findSweepObjective } from '../repositories/runAnalysisRepository.js';
import { findSavedView } from '../repositories/savedViewRepository.js';
import type { MetricSeriesService } from './metricSeriesService.js';
import type { RunAnalysisService } from './runAnalysisService.js';
import type { RunMediaService } from './runMediaService.js';
import type { RunSearchConditions, RunSearchService } from './runSearchService.js';

const runSearchConditionsSchema = runSearchSchema.omit({ limit: true, cursor: true });

export interface ReportSnapshotSources {
  runSearch: RunSearchService;
  metricSeries: MetricSeriesService;
  runAnalysis: RunAnalysisService;
  runMedia: RunMediaService;
}

/** What the analysis services accept: a saved view is turned into its search conditions. */
type SearchableRunSet = Exclude<RunSet, { search: unknown }> | { search: RunSearchConditions };

interface CaptureRequest {
  principal: Principal;
  projectId: string;
}

function tooManyRuns(maxRuns: number): never {
  throw new DomainError(
    422,
    `図に固定できるRunは${maxRuns}件までです。Run集合を絞ってください`,
    'too_many_runs',
  );
}

/**
 * Captures the data a snapshot block is drawn from, by calling the same services the live block
 * calls from the browser, with the saving editor's permissions. Each block is bounded by
 * REPORT_SNAPSHOT_BLOCK_MAX_BYTES (413 report_snapshot_too_large).
 */
export class ReportSnapshotService {
  constructor(
    private readonly database: Database,
    private readonly sources: ReportSnapshotSources,
  ) {}

  async capture(
    request: CaptureRequest,
    block: ReportEmbedBlock,
  ): Promise<{ data: ReportSnapshotData; sizeBytes: number }> {
    const data = await this.read(request, block);
    const sizeBytes = Buffer.byteLength(JSON.stringify(data));
    if (sizeBytes > REPORT_SNAPSHOT_BLOCK_MAX_BYTES)
      throw new DomainError(
        413,
        `ブロック${block.id}の固定データが5MiBを超えます。Run集合や系列を絞るか、最新データで描く設定にしてください`,
        'report_snapshot_too_large',
      );
    return { data, sizeBytes };
  }

  private async read(request: CaptureRequest, block: ReportEmbedBlock): Promise<ReportSnapshotData> {
    const { principal, projectId } = request;
    const { runAnalysis, runMedia } = this.sources;
    switch (block.type) {
      case 'chart':
        return this.readChart(request, block);
      case 'parallel_coordinates':
        return {
          type: block.type,
          table: await runAnalysis.readTable(principal, projectId, {
            runSet: await this.searchableRunSet(request, block.runSet),
            params: block.params,
            metrics: [block.metric],
          }),
        };
      case 'parameter_importance':
        return {
          type: block.type,
          importance: await runAnalysis.computeParameterImportance(principal, projectId, {
            runSet: await this.searchableRunSet(request, block.runSet),
            targetMetric: block.targetMetric,
          }),
        };
      case 'scatter':
        return this.readScatter(request, block);
      case 'run_table':
        return { type: block.type, runs: await this.readRunTable(request, block) };
      case 'media':
        return {
          type: block.type,
          grid: await runMedia.compare(principal, projectId, {
            runIds: block.runIds,
            key: block.key,
            steps: block.steps,
          }),
        };
      case 'media_table':
        return {
          type: block.type,
          page: await runMedia.table(
            principal,
            { projectId, runId: block.runId, mediaId: block.mediaId },
            { offset: 0, limit: MEDIA_TABLE_PAGE_MAX_ROWS },
          ),
        };
    }
  }

  private async readChart(
    request: CaptureRequest,
    block: ReportChartBlock,
  ): Promise<ReportSnapshotData> {
    const { principal, projectId } = request;
    const { panel } = block;
    const base = { keys: panel.metricKeys, xAxis: panel.xAxis, xRange: null };
    if (panel.groupBy) {
      const runIds = await this.resolveRunIds(request, block.runSet, MAX_GROUPED_RUNS);
      if (!runIds.length) return { type: 'chart', runs: [], groups: [] };
      const groups = await this.sources.metricSeries.readGroups(principal, projectId, {
        ...base,
        runIds,
        groupBy: panel.groupBy,
        maxPoints: DEFAULT_SERIES_POINTS,
      });
      const groupedRunIds = groups.groups.flatMap((group) => group.runIds);
      return {
        type: 'chart',
        runs: await readRunNames(this.database, { projectId, runIds: groupedRunIds }),
        groups: groups.groups,
      };
    }
    const runIds = await this.resolveRunIds(request, block.runSet, MAX_SERIES_RUNS);
    if (!runIds.length) return { type: 'chart', runs: [], series: [] };
    // Many Runs and keys share the response budget the series endpoint allows.
    const maxPoints = Math.max(
      1,
      Math.min(
        DEFAULT_SERIES_POINTS,
        Math.floor(MAX_RESPONSE_POINTS / (runIds.length * panel.metricKeys.length)),
      ),
    );
    const { series } = await this.sources.metricSeries.readSeries(principal, projectId, {
      ...base,
      runIds,
      maxPoints,
    });
    return {
      type: 'chart',
      runs: await readRunNames(this.database, { projectId, runIds }),
      series,
    };
  }

  private async readScatter(
    request: CaptureRequest,
    block: ReportScatterBlock,
  ): Promise<ReportSnapshotData> {
    const { principal, projectId } = request;
    const keys = scatterTableKeys(block);
    let metrics = keys.metrics;
    // Only an objective is plotted: the table needs a metric, and the objective's own one is read.
    if (!metrics.length && 'sweepId' in block.runSet) {
      const objective = await findSweepObjective(this.database, {
        projectId,
        sweepId: block.runSet.sweepId,
      });
      if (!objective) notFound('Sweep');
      metrics = [objective.metric];
    }
    return {
      type: 'scatter',
      table: await this.sources.runAnalysis.readTable(principal, projectId, {
        runSet: await this.searchableRunSet(request, block.runSet),
        params: keys.params.length ? keys.params : undefined,
        metrics,
      }),
    };
  }

  /** The first `limit` Runs of the set, in its order (the search order for a search). */
  private async readRunTable(request: CaptureRequest, block: ReportRunTableBlock) {
    const { principal, projectId } = request;
    const runSet = await this.searchableRunSet(request, block.runSet);
    if ('search' in runSet) {
      const page = await this.sources.runSearch.search(principal, projectId, {
        ...runSet.search,
        limit: block.limit,
        cursor: null,
      });
      return page.items;
    }
    const runIds =
      'runIds' in runSet
        ? runSet.runIds
        : await listSweepTrialRunIds(this.database, { projectId, sweepId: runSet.sweepId });
    return readRunSummaries(this.database, { projectId, runIds: runIds.slice(0, block.limit) });
  }

  /** An empty list for a search that matches nothing. */
  private async resolveRunIds(
    request: CaptureRequest,
    reportRunSet: ReportRunSet,
    maxRuns: number,
  ): Promise<string[]> {
    const runSet = await this.searchableRunSet(request, reportRunSet);
    const runIds =
      'search' in runSet
        ? await this.sources.runSearch.collectRunIds(request.principal, request.projectId, {
            conditions: runSet.search,
            maxRuns,
          })
        : 'runIds' in runSet
          ? runSet.runIds
          : await listSweepTrialRunIds(this.database, {
              projectId: request.projectId,
              sweepId: runSet.sweepId,
            });
    if (runIds.length > maxRuns) tooManyRuns(maxRuns);
    return runIds;
  }

  /** A saved view becomes its search conditions; a search gets the defaults it left out. */
  private async searchableRunSet(
    request: CaptureRequest,
    runSet: ReportRunSet,
  ): Promise<SearchableRunSet> {
    if ('search' in runSet) return { search: runSearchConditionsSchema.parse(runSet.search) };
    if (!('savedViewId' in runSet)) return runSet;
    const view = await findSavedView(this.database, {
      projectId: request.projectId,
      savedViewId: runSet.savedViewId,
    });
    // The save checked that the view is shared; one made private since then is not read.
    if (!view || view.visibility !== 'project') notFound('保存ビュー');
    const { experimentIds, filter, orderBy, statuses, kinds } = view.state;
    return {
      search: runSearchConditionsSchema.parse({ experimentIds, filter, orderBy, statuses, kinds }),
    };
  }
}
