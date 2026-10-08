import type { ReportEmbedBlock, ReportRunSet } from '@mmt/contracts';
import { loadLiveBlockData, loadRunSetSample } from '../api/reportLiveData';
import { reportsApi } from '../api/reports';
import { runMediaApi } from '../api/runMedia';
import { sweepsApi } from '../api/sweeps';
import { trackingApi } from '../api/tracking';
import { getRunColumnNames } from '../components/runs/runColumnNames';
import { useQuery } from './useQuery';

/** The current data of a live embed, read with the reader's permissions. Pass null for none. */
export function useLiveBlockData(projectId: string, block: Exclude<ReportEmbedBlock, { type: 'media_table' }> | null) {
  return useQuery(block ? `${projectId}:report-live:${JSON.stringify(block)}` : null, (signal) =>
    loadLiveBlockData(projectId, block!, signal),
  );
}

/** Runs, metric, param and tag names of a Run set, offered while an embed is configured. */
export function useRunSetFieldNames(projectId: string, runSet: ReportRunSet | null) {
  return useQuery(runSet ? `${projectId}:report-run-set-names:${JSON.stringify(runSet)}` : null, async (signal) => {
    const runs = await loadRunSetSample(projectId, runSet!, signal);
    const tagKeys = [...new Set(runs.flatMap((run) => Object.keys(run.tags)))].sort();
    return { runs, ...getRunColumnNames(runs), tagKeys };
  });
}

/** Run set sources the picker offers besides listed Runs and a search. */
export function useRunSetSources(projectId: string) {
  const savedViews = useQuery(`${projectId}:report-saved-views`, (signal) => reportsApi.shareableSavedViews(projectId, signal));
  const sweeps = useQuery(`${projectId}:report-sweeps`, (signal) => sweepsApi.list(projectId, { signal }));
  return { savedViews, sweeps };
}

// A table key rarely has more than a few steps; the picker lists the newest of them.
const TABLE_MEDIA_PER_KEY = 50;

/** The tables (media of kind table) a Run recorded, for embedding one of them. */
export function useRunTableMedia(projectId: string, runId: string) {
  return useQuery(runId ? `${projectId}:report-table-media:${runId}` : null, async (signal) => {
    const keys = (await runMediaApi.keys(projectId, runId, signal)).filter((summary) => summary.kind === 'table');
    const pages = await Promise.all(
      keys.map((summary) => runMediaApi.page(projectId, runId, { key: summary.key, kind: 'table', limit: TABLE_MEDIA_PER_KEY }, signal)),
    );
    return pages.flatMap((page) => page.items);
  });
}

// One search page of candidates; narrowing by name finds older Runs.
const RUN_CANDIDATE_LIMIT = 50;

/** Runs to pick from by name, newest first. */
export function useRunCandidates(projectId: string, name: string) {
  const trimmed = name.trim();
  return useQuery(`${projectId}:report-run-candidates:${trimmed}`, (signal) =>
    trackingApi.searchRuns(projectId, { ...(trimmed ? { name: trimmed } : {}), limit: RUN_CANDIDATE_LIMIT }, signal),
  );
}
