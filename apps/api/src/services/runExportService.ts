import type { Run } from '@mmt/contracts';
import type { Principal } from '../auth/principal.js';
import { rows, type Database } from '../db/database.js';
import { CSV_BYTE_ORDER_MARK, encodeCsvDocument, encodeCsvLine } from '../domain/csvEncoding.js';
import {
  comparisonCsvLines,
  RunExportKeyCollector,
  searchExportHeader,
  searchExportLine,
  truncationNoticeLine,
  type RunExportKeys,
  type RunReferenceLabels,
} from '../domain/runExportRows.js';
import { readComparedVersions } from '../repositories/runComparisonRepository.js';
import type { RunComparisonQuery, RunComparisonService } from './runComparisonService.js';
import type { RunSearchQuery, RunSearchService } from './runSearchService.js';

// The largest page run search serves; each page is its own short transaction.
const SEARCH_PAGE_SIZE = 500;

export type RunExportConditions = Omit<RunSearchQuery, 'limit' | 'cursor'>;

export interface RunSearchExport {
  fileName: string;
  /** More Runs matched than the row limit; the CSV ends with a notice line. */
  truncated: boolean;
  /** CSV text in pieces (BOM and header first). Reading it pulls one search page at a time. */
  chunks: AsyncIterable<string>;
}

// UTC keeps file names sortable and identical for every viewer of the same export.
const fileTimestamp = (now: Date) => now.toISOString().replace(/[-:]/g, '').slice(0, 15);

export class RunExportService {
  constructor(
    private readonly database: Database,
    private readonly services: {
      runSearch: RunSearchService;
      runComparison: RunComparisonService;
    },
    private readonly options: { maxRows: number },
  ) {}

  async exportComparison(
    principal: Principal,
    projectId: string,
    query: Omit<RunComparisonQuery, 'includeHistory'>,
  ): Promise<{ fileName: string; csv: string }> {
    const comparison = await this.services.runComparison.compare(principal, projectId, {
      ...query,
      includeHistory: false,
    });
    const labels: RunReferenceLabels = {
      experimentNames: await this.readExperimentNames(projectId),
      modelVersions: new Map(comparison.modelVersions.map((version) => [version.id, version])),
      datasetVersions: new Map(comparison.datasetVersions.map((version) => [version.id, version])),
    };
    return {
      fileName: `run-comparison-${fileTimestamp(new Date())}.csv`,
      csv: encodeCsvDocument(comparisonCsvLines(comparison, labels)),
    };
  }

  /**
   * Reads the search twice: first to learn the columns, the row count and whether the limit
   * cuts it (so the response headers are exact and errors answer before streaming starts), then
   * page by page while the client reads. No DB connection is held between pages, so a slow
   * download does not occupy the pool. Runs created between the passes are left out.
   */
  async exportSearch(
    principal: Principal,
    projectId: string,
    conditions: RunExportConditions,
  ): Promise<RunSearchExport> {
    const collector = new RunExportKeyCollector();
    const exportedRunIds = new Set<string>();
    let truncated = false;
    for await (const page of this.searchPages(principal, projectId, conditions)) {
      for (const run of page) {
        if (exportedRunIds.size === this.options.maxRows) {
          truncated = true;
          break;
        }
        exportedRunIds.add(run.id);
        collector.add(run);
      }
      if (truncated) break;
    }
    const keys = collector.keys();
    const experimentNames = await this.readExperimentNames(projectId);
    return {
      fileName: `runs-${fileTimestamp(new Date())}.csv`,
      truncated,
      chunks: this.searchExportChunks({
        principal,
        projectId,
        conditions,
        keys,
        exportedRunIds,
        experimentNames,
        truncated,
      }),
    };
  }

  private async *searchExportChunks(plan: {
    principal: Principal;
    projectId: string;
    conditions: RunExportConditions;
    keys: RunExportKeys;
    exportedRunIds: ReadonlySet<string>;
    experimentNames: ReadonlyMap<string, string>;
    truncated: boolean;
  }): AsyncGenerator<string> {
    yield CSV_BYTE_ORDER_MARK + encodeCsvLine(searchExportHeader(plan.keys));
    const remaining = new Set(plan.exportedRunIds);
    for await (const page of this.searchPages(plan.principal, plan.projectId, plan.conditions)) {
      const pageRuns = page.filter((run) => remaining.delete(run.id));
      if (pageRuns.length) {
        const labels = await this.readPageLabels(plan.projectId, {
          runs: pageRuns,
          experimentNames: plan.experimentNames,
        });
        yield pageRuns
          .map((run) => encodeCsvLine(searchExportLine(run, { keys: plan.keys, labels })))
          .join('');
      }
      if (!remaining.size) break;
    }
    if (plan.truncated) yield encodeCsvLine(truncationNoticeLine(this.options.maxRows));
  }

  private async *searchPages(
    principal: Principal,
    projectId: string,
    conditions: RunExportConditions,
  ): AsyncGenerator<Run[]> {
    let cursor: string | null = null;
    do {
      const page = await this.services.runSearch.search(principal, projectId, {
        ...conditions,
        limit: SEARCH_PAGE_SIZE,
        cursor,
      });
      yield page.items;
      cursor = page.nextCursor;
    } while (cursor);
  }

  private async readExperimentNames(projectId: string): Promise<Map<string, string>> {
    const experiments = await rows<{ id: string; name: string }>(
      this.database,
      'SELECT id,name FROM experiments WHERE project_id=$1',
      [projectId],
    );
    return new Map(experiments.map((experiment) => [experiment.id, experiment.name]));
  }

  private async readPageLabels(
    projectId: string,
    page: { runs: Run[]; experimentNames: ReadonlyMap<string, string> },
  ): Promise<RunReferenceLabels> {
    const versions = await readComparedVersions(this.database, {
      projectId,
      modelVersionIds: [...new Set(page.runs.flatMap((run) => run.modelVersionId ?? []))],
      datasetVersionIds: [...new Set(page.runs.flatMap((run) => run.inputDatasetVersionIds))],
    });
    return {
      experimentNames: page.experimentNames,
      modelVersions: new Map(versions.modelVersions.map((version) => [version.id, version])),
      datasetVersions: new Map(versions.datasetVersions.map((version) => [version.id, version])),
    };
  }
}
