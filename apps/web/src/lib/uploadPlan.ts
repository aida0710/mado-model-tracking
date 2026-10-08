// Pure planning for resumable Artifact uploads: part layout, resume diff, retry timing, and rate.
// The limits mirror the /artifact-uploads contract in docs/api-contract.md.

const MIB = 1024 * 1024;
/** Files below this go through the single PUT: a session costs three extra requests. */
export const SINGLE_PUT_MAX_BYTES = 8 * MIB;
/** Same as the API default, so a session created without partSize would have the same layout. */
export const DEFAULT_PART_SIZE_BYTES = 16 * MIB;
/** The API rejects sessions with more parts (422 too_many_parts). */
export const MAX_PART_COUNT = 10_000;
/** One failed part is retried this many times in total before the file stops as failed. */
export const MAX_PART_ATTEMPTS = 5;
const RETRY_BASE_DELAY_MS = 1000;
// A dropped network usually returns within seconds; waiting longer only delays the failure notice.
const RETRY_MAX_DELAY_MS = 30_000;
/** Rate is averaged over this window so one slow progress event does not swing the estimate. */
export const TRANSFER_RATE_WINDOW_MS = 5000;

export type UploadMethod = 'single' | 'multipart';

export interface PartRange {
  partNumber: number;
  /** Inclusive byte offset. */
  start: number;
  /** Exclusive byte offset. */
  end: number;
}

export function chooseUploadMethod(fileSize: number): UploadMethod {
  return fileSize < SINGLE_PUT_MAX_BYTES ? 'single' : 'multipart';
}

/** Grows the part size in whole MiB only when the default would exceed MAX_PART_COUNT parts. */
export function choosePartSize(fileSize: number): number {
  const smallestAllowed = Math.ceil(Math.ceil(fileSize / MAX_PART_COUNT) / MIB) * MIB;
  return Math.max(DEFAULT_PART_SIZE_BYTES, smallestAllowed);
}

/** Every part has partSize bytes except the last, which holds the remainder. */
export function planParts(fileSize: number, partSize: number): PartRange[] {
  if (partSize <= 0) throw new RangeError('partSize must be positive');
  const parts: PartRange[] = [];
  for (let start = 0; start < fileSize; start += partSize)
    parts.push({ partNumber: parts.length + 1, start, end: Math.min(start + partSize, fileSize) });
  return parts;
}

export function findMissingParts(parts: PartRange[], receivedPartNumbers: Iterable<number>): PartRange[] {
  const received = new Set(receivedPartNumbers);
  return parts.filter((part) => !received.has(part.partNumber));
}

export function sumPartBytes(parts: PartRange[]): number {
  return parts.reduce((total, part) => total + part.end - part.start, 0);
}

/**
 * Network loss (status 0), timeouts, throttling, and server errors are worth another attempt.
 * A part checksum mismatch means the bytes changed on the way, so sending them again can succeed.
 * Other 4xx answers (closed or expired session, size mismatch) will not change by retrying.
 */
export function isRetryableFailure({ status, code }: { status: number; code?: string }): boolean {
  if (status === 0 || status === 408 || status === 429 || status >= 500) return true;
  return code === 'part_checksum_mismatch';
}

/** `attempt` is the number of attempts already made, starting at 1. */
export function canRetry(attempt: number): boolean {
  return attempt < MAX_PART_ATTEMPTS;
}

/**
 * Exponential backoff with equal jitter: half the delay is fixed and half is random, so parallel
 * parts that failed together do not all come back at the same instant.
 */
export function retryDelayMs(attempt: number, random: () => number = Math.random): number {
  const exponential = Math.min(RETRY_MAX_DELAY_MS, RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
  return Math.round(exponential / 2 + (exponential / 2) * random());
}

export interface TransferSample {
  at: number;
  /** Total bytes confirmed or in flight for the file at `at`. */
  bytes: number;
}

/** Keeps the samples inside the rate window plus the one just before it, as the window's base. */
export function recordTransferSample(samples: TransferSample[], sample: TransferSample): TransferSample[] {
  const windowStart = sample.at - TRANSFER_RATE_WINDOW_MS;
  const firstInside = samples.findIndex((item) => item.at >= windowStart);
  const kept = firstInside === -1 ? samples.slice(-1) : samples.slice(Math.max(0, firstInside - 1));
  return [...kept, sample];
}

/** Bytes per second across the samples, or null until two samples are apart in time. */
export function estimateTransferRate(samples: TransferSample[]): number | null {
  const first = samples[0];
  const last = samples.at(-1);
  if (!first || !last || last.at <= first.at) return null;
  return Math.max(0, ((last.bytes - first.bytes) * 1000) / (last.at - first.at));
}

export function estimateRemainingSeconds(remainingBytes: number, bytesPerSecond: number | null): number | null {
  if (bytesPerSecond === null || bytesPerSecond <= 0) return null;
  return Math.ceil(remainingBytes / bytesPerSecond);
}

/** Joins the destination folder and the file's path inside the chosen folder with single slashes. */
export function joinArtifactPath(prefix: string, relativePath: string): string {
  return [prefix, relativePath]
    .flatMap((segment) => segment.split('/'))
    .filter((segment) => segment !== '')
    .join('/');
}
