import { ArtifactRangeError } from './artifactTypes.js';

export interface ByteRange {
  start: number;
  end: number;
}
export function parseArtifactRange(range: string | undefined, totalSize: number): ByteRange | null {
  if (range === undefined) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match || totalSize === 0 || (!match[1] && !match[2]))
    throw new ArtifactRangeError(totalSize);
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) throw new ArtifactRangeError(totalSize);
    return { start: Math.max(0, totalSize - suffix), end: totalSize - 1 };
  }
  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : totalSize - 1;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(requestedEnd) ||
    start >= totalSize ||
    requestedEnd < start
  ) {
    throw new ArtifactRangeError(totalSize);
  }
  return { start, end: Math.min(requestedEnd, totalSize - 1) };
}
