import { useState } from 'react';
import type { ReportDocument, ReportUpdate } from '@mmt/contracts';
import { isReportRevisionConflict, reportsApi } from '../api/reports';
import { formatErrorMessage } from '../lib/errorMessage';
import { useQuery } from './useQuery';

/**
 * One revision of a report (the current one when `revision` is undefined) and the snapshots stored
 * with it. Snapshots are read only when a block needs them.
 */
export function useReportDocument(projectId: string, reportId: string, revision: number | undefined) {
  const document = useQuery(`${projectId}:report:${reportId}:${revision ?? 'current'}`, (signal) =>
    reportsApi.get(projectId, reportId, { revision, signal }),
  );
  const shownRevision = document.value?.revision;
  const hasSnapshotBlocks = shownRevision?.blocks.some((block) => block.type !== 'markdown' && block.mode === 'snapshot');
  const snapshots = useQuery(
    shownRevision && hasSnapshotBlocks ? `${projectId}:report-snapshots:${reportId}:${shownRevision.revision}` : null,
    (signal) => reportsApi.snapshots(projectId, reportId, shownRevision!.revision, signal),
  );
  return { document, snapshots };
}

export function useReportRevisions(projectId: string, reportId: string, currentRevision: number | undefined) {
  // Keyed by the current revision so a save or restore lists the new revision.
  return useQuery(currentRevision === undefined ? null : `${projectId}:report-revisions:${reportId}:${currentRevision}`, (signal) =>
    reportsApi.revisions(projectId, reportId, signal),
  );
}

export type ReportSaveOutcome =
  | { kind: 'saved'; document: ReportDocument }
  | { kind: 'conflict' }
  | { kind: 'failed' };

/**
 * Saves an edit on top of the revision it started from. A 409 report_revision_conflict is kept
 * apart from other failures: someone else saved first, and the edit must not overwrite it.
 */
export function useReportSave(projectId: string, reportId: string) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasConflict, setHasConflict] = useState(false);

  async function run(operation: () => Promise<ReportDocument>): Promise<ReportSaveOutcome> {
    setPending(true);
    setError(null);
    setHasConflict(false);
    try {
      return { kind: 'saved', document: await operation() };
    } catch (failure) {
      if (isReportRevisionConflict(failure)) {
        setHasConflict(true);
        return { kind: 'conflict' };
      }
      setError(formatErrorMessage(failure));
      return { kind: 'failed' };
    } finally {
      setPending(false);
    }
  }

  return {
    pending,
    error,
    hasConflict,
    save: (input: ReportUpdate) => run(() => reportsApi.update(projectId, reportId, input)),
  };
}
