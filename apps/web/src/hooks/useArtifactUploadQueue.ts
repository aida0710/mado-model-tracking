import { useCallback, useEffect, useRef, useState } from 'react';
import type { Artifact, ArtifactUpload, ArtifactUploadDetail } from '@mmt/contracts';
import { artifactUploadsApi } from '../api/artifactUploads';
import { RequestError } from '../api/http';
import { trackingApi } from '../api/tracking';
import { canDigest, sha256Hex } from '../lib/blobDigest';
import type { UploadSource } from '../lib/droppedFiles';
import { formatErrorMessage } from '../lib/errorMessage';
import {
  canRetry,
  choosePartSize,
  chooseUploadMethod,
  estimateRemainingSeconds,
  estimateTransferRate,
  findMissingParts,
  isRetryableFailure,
  planParts,
  recordTransferSample,
  retryDelayMs,
  sumPartBytes,
  type PartRange,
  type TransferSample,
  type UploadMethod,
} from '../lib/uploadPlan';
import { findResumeRecord, removeResumeRecord, saveResumeRecord } from '../lib/uploadResumeStore';
import { useQuery } from './useQuery';
import { text } from '../i18n/catalog';

/**
 * Requests in flight across the whole queue. Browsers allow six connections per origin over
 * HTTP/1.1; three keeps the line busy while leaving room for page polling and previews.
 */
export const MAX_CONCURRENT_REQUESTS = 3;
// The finalizer hashes the whole object; once a second is enough to show it finish.
const VERIFY_POLL_INTERVAL_MS = 1000;
// Progress events arrive many times per second; the list re-renders at most this often.
const PROGRESS_RENDER_INTERVAL_MS = 200;
// Session states after which the parts are gone and a new session must start from the first byte.
const CLOSED_SESSION_CODES = new Set(['upload_not_open', 'upload_expired']);

export type UploadItemStatus =
  | 'queued'
  | 'preparing'
  | 'uploading'
  | 'verifying'
  | 'paused'
  | 'failed'
  | 'canceled'
  | 'completed';

const ACTIVE_STATUSES: ReadonlySet<UploadItemStatus> = new Set(['queued', 'preparing', 'uploading', 'verifying']);

/** What the queue panel shows for one file. */
export interface UploadItem {
  id: string;
  name: string;
  path: string;
  size: number;
  method: UploadMethod;
  status: UploadItemStatus;
  sentBytes: number;
  /** Bytes the server already had when the file resumed; they were not sent again. */
  resumedBytes: number;
  bytesPerSecond: number | null;
  remainingSeconds: number | null;
  error: string | null;
  artifact: Artifact | null;
}

export interface UploadEntry {
  source: UploadSource;
  path: string;
}

/** Mutable state of one file while requests are running; UploadItem is its rendered copy. */
interface UploadJob {
  id: string;
  source: UploadSource;
  path: string;
  method: UploadMethod;
  status: UploadItemStatus;
  session: ArtifactUpload | null;
  pendingParts: PartRange[];
  /** Bytes sent so far by each part request in flight. */
  inFlightParts: Map<number, number>;
  confirmedBytes: number;
  resumedBytes: number;
  samples: TransferSample[];
  /** Replaced on every start, so requests of a paused or canceled attempt change nothing. */
  controller: AbortController;
  error: string | null;
  artifact: Artifact | null;
}

export function useArtifactUploadQueue({
  projectId,
  runId,
  onCompleted,
}: {
  projectId: string;
  runId: string | null;
  onCompleted: (artifact: Artifact) => void;
}) {
  const jobsRef = useRef<UploadJob[]>([]);
  const activeRequestsRef = useRef(0);
  const nextJobNumberRef = useRef(1);
  const renderTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Sessions this queue has taken over; the server list is not reloaded, so they are hidden here.
  const queuedSessionIdsRef = useRef(new Set<string>());
  const onCompletedRef = useRef(onCompleted);
  onCompletedRef.current = onCompleted;
  const [items, setItems] = useState<UploadItem[]>([]);
  const openSessions = useQuery(`${projectId}:artifact-uploads:open`, (signal) =>
    artifactUploadsApi.list(projectId, 'open', signal),
  );
  const openSessionsRef = useRef<ArtifactUpload[]>([]);
  openSessionsRef.current = (openSessions.value ?? []).filter((session) => session.runId === runId);

  const render = useCallback(() => {
    if (renderTimerRef.current) clearTimeout(renderTimerRef.current);
    renderTimerRef.current = null;
    const now = Date.now();
    setItems(jobsRef.current.map((job) => toItem(job, now)));
  }, []);
  const renderSoon = useCallback(() => {
    renderTimerRef.current ??= setTimeout(render, PROGRESS_RENDER_INTERVAL_MS);
  }, [render]);

  // The callbacks below close over refs only, so they stay valid for the whole dialog.
  const failJob = useCallback(
    (job: UploadJob, failure: unknown) => {
      if (failure instanceof RequestError && failure.code && CLOSED_SESSION_CODES.has(failure.code)) {
        if (job.session) removeResumeRecord(job.session.id);
        job.session = null;
      }
      job.controller.abort();
      job.status = 'failed';
      job.error = formatErrorMessage(failure);
      job.pendingParts = [];
      job.inFlightParts.clear();
      render();
    },
    [render],
  );

  const finishCompleted = useCallback(
    (job: UploadJob, artifact: Artifact) => {
      job.status = 'completed';
      job.artifact = artifact;
      job.confirmedBytes = job.source.file.size;
      render();
      onCompletedRef.current(artifact);
    },
    [render],
  );

  const finalize = useCallback(
    async (job: UploadJob, session: ArtifactUpload) => {
      const { signal } = job.controller;
      job.status = 'verifying';
      render();
      try {
        let current: ArtifactUpload = session.status === 'open'
          ? await artifactUploadsApi.complete(projectId, session.id, signal)
          : session;
        while (current.status === 'verifying') {
          await waitFor(VERIFY_POLL_INTERVAL_MS, signal);
          current = await artifactUploadsApi.get(projectId, session.id, signal);
        }
        // A completed session stays referenced until its Artifact is read, so a resume can retry that read.
        const artifact = current.status === 'completed' && current.artifactId
          ? await trackingApi.artifact(projectId, current.artifactId, signal)
          : null;
        removeResumeRecord(session.id);
        job.session = null;
        if (!artifact) throw new Error(`${text.uploadVerificationFailed} (${current.error ?? current.status})`);
        finishCompleted(job, artifact);
      } catch (failure) {
        if (!signal.aborted) failJob(job, failure);
      }
    },
    [failJob, finishCompleted, projectId, render],
  );

  const sendPart = useCallback(
    async (job: UploadJob, part: PartRange) => {
      const { signal } = job.controller;
      const session = job.session;
      if (!session) return;
      try {
        await retrying(signal, async () => {
          // Set before the first await so the last part to finish sees the others in flight.
          job.inFlightParts.set(part.partNumber, 0);
          const slice = job.source.file.slice(part.start, part.end);
          const bytes = canDigest() ? await slice.arrayBuffer() : null;
          await artifactUploadsApi.putPart(
            {
              projectId,
              uploadId: session.id,
              partNumber: part.partNumber,
              body: bytes ?? slice,
              sha256: bytes ? await sha256Hex(bytes) : null,
            },
            {
              signal,
              onProgress: (sentBytes) => {
                job.inFlightParts.set(part.partNumber, sentBytes);
                renderSoon();
              },
            },
          );
        });
      } catch (failure) {
        if (!signal.aborted) failJob(job, failure);
        return;
      }
      if (signal.aborted) return;
      job.inFlightParts.delete(part.partNumber);
      job.confirmedBytes += part.end - part.start;
      renderSoon();
      if (job.pendingParts.length === 0 && job.inFlightParts.size === 0) void finalize(job, session);
    },
    [failJob, finalize, projectId, renderSoon],
  );

  const sendSingle = useCallback(
    async (job: UploadJob) => {
      const { signal } = job.controller;
      job.status = 'uploading';
      render();
      try {
        const artifact = await retrying(signal, () =>
          artifactUploadsApi.putSingle(
            { projectId, runId, path: job.path, file: job.source.file },
            {
              signal,
              onProgress: (sentBytes) => {
                job.inFlightParts.set(1, sentBytes);
                renderSoon();
              },
            },
          ),
        );
        if (signal.aborted) return;
        job.inFlightParts.clear();
        finishCompleted(job, artifact);
      } catch (failure) {
        if (!signal.aborted) failJob(job, failure);
      }
    },
    [failJob, finishCompleted, projectId, render, renderSoon, runId],
  );

  const prepareSession = useCallback(
    async (job: UploadJob) => {
      const { signal } = job.controller;
      try {
        const file = job.source.file;
        const identity = { projectId, runId, path: job.path, name: file.name, size: file.size, lastModified: file.lastModified };
        const storedRecord = findResumeRecord(identity);
        const resumable = await findResumableSession({
          projectId,
          file,
          candidates: [
            ...(job.session ? [{ uploadId: job.session.id, isSameFile: true }] : []),
            ...(storedRecord ? [{ uploadId: storedRecord.uploadId, isSameFile: true }] : []),
            ...openSessionsRef.current
              .filter((session) => session.path === job.path && session.expectedSize === file.size)
              .map((session) => ({ uploadId: session.id, isSameFile: false })),
          ],
          signal,
        });
        if (signal.aborted) return;
        const session = resumable ?? await artifactUploadsApi.create(
          projectId,
          {
            path: job.path,
            ...(runId ? { runId } : {}),
            ...(file.type ? { mimeType: file.type } : {}),
            expectedSize: file.size,
            partSize: choosePartSize(file.size),
          },
          signal,
        );
        if (signal.aborted) return;
        job.session = session;
        queuedSessionIdsRef.current.add(session.id);
        saveResumeRecord({ uploadId: session.id, ...identity });
        if (session.status !== 'open') {
          void finalize(job, session);
          return;
        }
        const receivedPartNumbers = 'receivedParts' in session
          ? (session as ArtifactUploadDetail).receivedParts.map((part) => part.partNumber)
          : [];
        const parts = planParts(file.size, session.partSize);
        const missing = findMissingParts(parts, receivedPartNumbers);
        job.confirmedBytes = file.size - sumPartBytes(missing);
        job.resumedBytes = job.confirmedBytes;
        job.samples = [];
        job.pendingParts = missing;
        job.status = 'uploading';
        render();
        if (missing.length === 0) void finalize(job, session);
      } catch (failure) {
        if (!signal.aborted) failJob(job, failure);
      }
    },
    [failJob, finalize, projectId, render, runId],
  );

  const pump = useCallback(() => {
    while (activeRequestsRef.current < MAX_CONCURRENT_REQUESTS) {
      const task = takeNextTask(jobsRef.current, { prepareSession, sendPart, sendSingle });
      if (!task) break;
      activeRequestsRef.current += 1;
      void task().finally(() => {
        activeRequestsRef.current -= 1;
        pump();
      });
    }
    render();
  }, [prepareSession, render, sendPart, sendSingle]);

  const enqueue = useCallback(
    (entries: UploadEntry[]) => {
      for (const { source, path } of entries)
        jobsRef.current.push({
          id: String(nextJobNumberRef.current++),
          source,
          path,
          method: chooseUploadMethod(source.file.size),
          status: 'queued',
          session: null,
          pendingParts: [],
          inFlightParts: new Map(),
          confirmedBytes: 0,
          resumedBytes: 0,
          samples: [],
          controller: new AbortController(),
          error: null,
          artifact: null,
        });
      pump();
    },
    [pump],
  );

  const findJob = (id: string) => jobsRef.current.find((job) => job.id === id);

  /** Stops sending but keeps the session, so resume sends only the parts the server lacks. */
  const pause = useCallback(
    (id: string) => {
      const job = findJob(id);
      if (!job || !['queued', 'preparing', 'uploading'].includes(job.status)) return;
      stopRequests(job);
      job.status = 'paused';
      pump();
    },
    [pump],
  );

  const resume = useCallback(
    (id: string) => {
      const job = findJob(id);
      if (!job || (job.status !== 'paused' && job.status !== 'failed')) return;
      job.controller = new AbortController();
      job.status = 'queued';
      job.error = null;
      pump();
    },
    [pump],
  );

  const retryFailed = useCallback(() => {
    for (const job of jobsRef.current) if (job.status === 'failed') resume(job.id);
  }, [resume]);

  /** Stops the file and discards what the server received (DELETE), so no Artifact appears. */
  const cancel = useCallback(
    async (id: string) => {
      const job = findJob(id);
      if (!job || job.status === 'completed' || job.status === 'canceled' || job.status === 'verifying') return;
      stopRequests(job);
      job.status = 'canceled';
      const session = job.session;
      job.session = null;
      pump();
      if (!session) return;
      removeResumeRecord(session.id);
      try {
        await artifactUploadsApi.abort(projectId, session.id);
      } catch (failure) {
        // A session that already closed keeps nothing; anything else expires with the session.
        if (!(failure instanceof RequestError && failure.code === 'upload_not_open')) {
          job.error = `${text.uploadCancelNotSent}: ${formatErrorMessage(failure)}`;
          render();
        }
      }
    },
    [projectId, pump, render],
  );

  const discardSession = useCallback(
    async (uploadId: string) => {
      removeResumeRecord(uploadId);
      await artifactUploadsApi.abort(projectId, uploadId);
      openSessions.reload();
    },
    [openSessions, projectId],
  );

  const isActive = items.some((item) => ACTIVE_STATUSES.has(item.status));
  useEffect(() => {
    if (!isActive) return;
    function warnBeforeUnload(event: BeforeUnloadEvent) {
      event.preventDefault();
      event.returnValue = '';
    }
    window.addEventListener('beforeunload', warnBeforeUnload);
    return () => window.removeEventListener('beforeunload', warnBeforeUnload);
  }, [isActive]);

  // Leaving the dialog stops the requests; open sessions stay on the server for a later resume.
  useEffect(
    () => () => {
      for (const job of jobsRef.current) job.controller.abort();
      if (renderTimerRef.current) clearTimeout(renderTimerRef.current);
    },
    [],
  );

  return {
    items,
    isActive,
    enqueue,
    pause,
    resume,
    cancel,
    retryFailed,
    resumableSessions: openSessionsRef.current.filter((session) => !queuedSessionIdsRef.current.has(session.id)),
    resumableSessionsError: openSessions.error,
    discardSession,
  };
}

function toItem(job: UploadJob, now: number): UploadItem {
  const inFlightBytes = [...job.inFlightParts.values()].reduce((total, bytes) => total + bytes, 0);
  const sentBytes = Math.min(job.source.file.size, job.confirmedBytes + inFlightBytes);
  const isSending = job.status === 'uploading';
  if (isSending) job.samples = recordTransferSample(job.samples, { at: now, bytes: sentBytes });
  const bytesPerSecond = isSending ? estimateTransferRate(job.samples) : null;
  return {
    id: job.id,
    name: job.source.file.name,
    path: job.path,
    size: job.source.file.size,
    method: job.method,
    status: job.status,
    sentBytes,
    resumedBytes: job.resumedBytes,
    bytesPerSecond,
    remainingSeconds: estimateRemainingSeconds(job.source.file.size - sentBytes, bytesPerSecond),
    error: job.error,
    artifact: job.artifact,
  };
}

function stopRequests(job: UploadJob) {
  job.controller.abort();
  job.pendingParts = [];
  job.inFlightParts.clear();
  job.samples = [];
}

/** Next request in queue order: prepare files first come first, then fill free slots with parts. */
function takeNextTask(
  jobs: UploadJob[],
  handlers: {
    prepareSession: (job: UploadJob) => Promise<void>;
    sendPart: (job: UploadJob, part: PartRange) => Promise<void>;
    sendSingle: (job: UploadJob) => Promise<void>;
  },
): (() => Promise<void>) | null {
  for (const job of jobs) {
    if (job.status === 'queued') {
      job.status = 'preparing';
      return job.method === 'single' ? () => handlers.sendSingle(job) : () => handlers.prepareSession(job);
    }
    const part = job.status === 'uploading' ? job.pendingParts.shift() : undefined;
    if (part) return () => handlers.sendPart(job, part);
  }
  return null;
}

/**
 * Picks the first candidate session that is still usable for this file. A session found only
 * on the server (no local record) may belong to another file with the same path and size, so one
 * of its received parts must hash the same as the chosen file before it is resumed.
 */
async function findResumableSession({
  projectId,
  file,
  candidates,
  signal,
}: {
  projectId: string;
  file: File;
  candidates: { uploadId: string; isSameFile: boolean }[];
  signal: AbortSignal;
}): Promise<ArtifactUploadDetail | null> {
  const tried = new Set<string>();
  for (const { uploadId, isSameFile } of candidates) {
    if (tried.has(uploadId)) continue;
    tried.add(uploadId);
    let detail: ArtifactUploadDetail;
    try {
      detail = await artifactUploadsApi.get(projectId, uploadId, signal);
    } catch (failure) {
      if (failure instanceof RequestError && failure.status >= 400 && failure.status < 500) {
        removeResumeRecord(uploadId);
        continue;
      }
      throw failure;
    }
    const isUsable =
      detail.expectedSize === file.size &&
      (detail.status === 'open' || detail.status === 'verifying' || detail.status === 'completed') &&
      (isSameFile || (await hasSameReceivedBytes(file, detail)));
    if (isUsable) return detail;
    removeResumeRecord(uploadId);
  }
  return null;
}

async function hasSameReceivedBytes(file: File, detail: ArtifactUploadDetail): Promise<boolean> {
  if (detail.status !== 'open') return false;
  const sample = detail.receivedParts[0];
  if (!sample) return true;
  if (!canDigest()) return false;
  const start = (sample.partNumber - 1) * detail.partSize;
  const bytes = await file.slice(start, start + sample.size).arrayBuffer();
  return (await sha256Hex(bytes)) === sample.sha256;
}

async function retrying<T>(signal: AbortSignal, send: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await send();
    } catch (failure) {
      const isRetryable = failure instanceof RequestError && isRetryableFailure(failure) && canRetry(attempt);
      if (signal.aborted || !isRetryable) throw failure;
      await waitFor(retryDelayMs(attempt), signal);
    }
  }
}

function waitFor(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', stop);
      resolve();
    }, milliseconds);
    function stop() {
      clearTimeout(timer);
      reject(new DOMException('Upload aborted', 'AbortError'));
    }
    signal.addEventListener('abort', stop, { once: true });
  });
}
