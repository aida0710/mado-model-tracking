import {
  ANALYSIS_MAX_RUNS,
  type ParameterImportanceResult,
  type RunAnalysisRow,
  type RunAnalysisTableResponse,
  type SweepObjective,
} from '@mmt/contracts';
import type { Principal } from '../auth/principal.js';
import type { Database } from '../db/database.js';
import {
  computeParameterImportance,
  DEFAULT_IMPORTANCE_SEED,
} from '../domain/analysis/parameterImportance.js';
import { DomainError, notFound } from '../domain/errors.js';
import type {
  ParameterImportanceQuery,
  RunAnalysisTableQuery,
  RunSetQuery,
} from '../domain/runAnalysisValidation.js';
import {
  describeAnalysisParams,
  finiteRange,
  parseLatestMetricValue,
  pickParams,
  selectAnalysisParams,
  toResponseMetric,
} from '../domain/runAnalysisTable.js';
import {
  findSweepObjective,
  readRunAnalysisSources,
  readSweepAnalysisSources,
  type RunAnalysisSource,
} from '../repositories/runAnalysisRepository.js';
import { requireProject } from './accessService.js';
import type { RunSearchService } from './runSearchService.js';

// A fixed forest seed: the same Runs and params always give the same importance.
const IMPORTANCE_SEED = DEFAULT_IMPORTANCE_SEED;

interface LoadedRunSet {
  sources: RunAnalysisSource[];
  /** Set only when the Run set is a sweep. */
  sweepObjective: SweepObjective | null;
}

function tooManyRuns(): never {
  throw new DomainError(
    422,
    `分析できるRunは${ANALYSIS_MAX_RUNS}件までです。条件を絞ってください`,
    'too_many_runs',
  );
}

function readMetricValue(source: RunAnalysisSource, key: string): number | undefined {
  return parseLatestMetricValue(source.latestMetrics[key]);
}

export class RunAnalysisService {
  constructor(
    private readonly database: Database,
    private readonly runSearch: RunSearchService,
  ) {}

  async readTable(
    principal: Principal,
    projectId: string,
    query: RunAnalysisTableQuery,
  ): Promise<RunAnalysisTableResponse> {
    await requireProject(this.database, principal, { projectId, role: 'viewer', scope: 'read' });
    const { sources, sweepObjective } = await this.loadRunSet(principal, projectId, {
      runSet: query.runSet,
      metricKeys: query.metrics,
    });
    const allParameters = sources.map((source) => source.parameters);
    const paramKeys = selectAnalysisParams(allParameters, query.params);
    const runs = sources.map((source): RunAnalysisRow => {
      const metrics: Record<string, number | null> = {};
      for (const key of query.metrics) {
        const value = readMetricValue(source, key);
        if (value !== undefined) metrics[key] = toResponseMetric(value);
      }
      return {
        runId: source.runId,
        name: source.name,
        experimentId: source.experimentId,
        status: source.status,
        ...(source.sweepTrialIndex !== null ? { sweepTrialIndex: source.sweepTrialIndex } : {}),
        params: pickParams(source.parameters, paramKeys),
        metrics,
        ...(sweepObjective ? { objective: source.sweepObjectiveValue } : {}),
      };
    });
    return {
      runs,
      params: describeAnalysisParams(allParameters, paramKeys),
      metrics: query.metrics.map((key) => ({
        key,
        ...finiteRange(sources.map((source) => readMetricValue(source, key))),
      })),
      ...(sweepObjective
        ? {
            objective: {
              ...sweepObjective,
              ...finiteRange(sources.map((source) => source.sweepObjectiveValue)),
            },
          }
        : {}),
    };
  }

  async computeParameterImportance(
    principal: Principal,
    projectId: string,
    query: ParameterImportanceQuery,
  ): Promise<ParameterImportanceResult> {
    await requireProject(this.database, principal, { projectId, role: 'viewer', scope: 'read' });
    const isSweep = 'sweepId' in query.runSet;
    if (!isSweep && query.targetMetric === undefined)
      throw new DomainError(422, 'targetMetricを指定してください', 'target_metric_required');
    const { sources, sweepObjective } = await this.loadRunSet(principal, projectId, {
      runSet: query.runSet,
      metricKeys: query.targetMetric === undefined ? [] : [query.targetMetric],
    });
    const targetSource = query.targetMetric === undefined ? 'sweep_objective' : 'latest_metric';
    const targetMetric = query.targetMetric ?? sweepObjective!.metric;
    const paramKeys = selectAnalysisParams(
      sources.map((source) => source.parameters),
      query.params,
    );
    // The forest bootstraps in input order; a fixed order makes runIds, search and sweep agree.
    const ordered = [...sources].sort((left, right) =>
      left.runId < right.runId ? -1 : left.runId > right.runId ? 1 : 0,
    );
    const result = computeParameterImportance({
      runs: ordered.map((source) => ({
        parameters: source.parameters,
        metrics: {
          [targetMetric]:
            targetSource === 'sweep_objective'
              ? source.sweepObjectiveValue
              : readMetricValue(source, targetMetric),
        },
      })),
      objectiveMetric: targetMetric,
      parameterNames: paramKeys,
      seed: IMPORTANCE_SEED,
    });
    return {
      targetMetric,
      targetSource,
      runCount: result.runCount,
      skippedRunCount: result.skippedRunCount,
      entries: result.entries,
      excluded: result.excluded,
      importanceUnavailableReason: result.importanceUnavailableReason,
      outOfBagR2: result.outOfBagR2,
    };
  }

  private async loadRunSet(
    principal: Principal,
    projectId: string,
    request: { runSet: RunSetQuery; metricKeys: string[] },
  ): Promise<LoadedRunSet> {
    const { runSet, metricKeys } = request;
    if ('sweepId' in runSet) {
      const sweep = { projectId, sweepId: runSet.sweepId };
      const sweepObjective = await findSweepObjective(this.database, sweep);
      if (!sweepObjective) notFound('Sweep');
      const sources = await readSweepAnalysisSources(this.database, {
        ...sweep,
        metricKeys,
        limit: ANALYSIS_MAX_RUNS + 1,
      });
      if (sources.length > ANALYSIS_MAX_RUNS) tooManyRuns();
      return { sources, sweepObjective };
    }
    if ('runIds' in runSet) {
      if (runSet.runIds.length > ANALYSIS_MAX_RUNS) tooManyRuns();
      const sources = await readRunAnalysisSources(this.database, {
        projectId,
        runIds: runSet.runIds,
        metricKeys,
      });
      // Another Project's Run is reported like a missing one so its existence does not leak.
      if (sources.length !== runSet.runIds.length) notFound('Run');
      return { sources, sweepObjective: null };
    }
    const runIds = await this.runSearch.collectRunIds(principal, projectId, {
      conditions: runSet.search,
      maxRuns: ANALYSIS_MAX_RUNS,
    });
    // A Run deleted after the search simply drops out; the search itself was already authorized.
    const sources = runIds.length
      ? await readRunAnalysisSources(this.database, { projectId, runIds, metricKeys })
      : [];
    return { sources, sweepObjective: null };
  }
}
