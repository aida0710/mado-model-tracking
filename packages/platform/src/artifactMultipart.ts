import { createHash } from 'node:crypto';
import { Transform, type TransformCallback } from 'node:stream';
import type { MultipartCompletion } from './artifactTypes.js';

// S3 rejects non-final parts below 5 MiB at completion; the same rule keeps sessions portable
// between backends.
export const MULTIPART_MIN_PART_BYTES = 5 * 1024 * 1024;
// S3 UploadPart accepts at most 5 GiB per request.
export const MULTIPART_MAX_PART_BYTES = 5 * 1024 * 1024 * 1024;
// S3 part numbers run from 1 to 10000.
export const MULTIPART_MAX_PART_COUNT = 10_000;

export class ArtifactPartMismatchError extends Error {
  constructor(readonly mismatch: 'size' | 'sha256') {
    super(
      mismatch === 'size'
        ? 'Part body length differs from its declared size'
        : 'Part body digest differs from its declared SHA-256',
    );
    this.name = 'ArtifactPartMismatchError';
  }
}
/** The backend no longer knows the multipart upload (completed, aborted or never created). */
export class ArtifactUploadNotFoundError extends Error {
  constructor() {
    super('Multipart upload does not exist');
    this.name = 'ArtifactUploadNotFoundError';
  }
}
export class ArtifactPartTooSmallError extends Error {
  constructor(readonly partNumber: number) {
    super(`Part ${partNumber} is below the minimum size of a non-final part`);
    this.name = 'ArtifactPartTooSmallError';
  }
}

/**
 * Hashes a part while it streams to storage and fails the stream as soon as its length cannot
 * match the declared size, so a short or long body never becomes a stored part.
 */
export class ArtifactPartCheck extends Transform {
  private readonly hash = createHash('sha256');
  private receivedBytes = 0;

  constructor(private readonly expected: { size: number; sha256?: string }) {
    super();
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
    this.receivedBytes += chunk.byteLength;
    if (this.receivedBytes > this.expected.size) {
      callback(new ArtifactPartMismatchError('size'));
      return;
    }
    this.hash.update(chunk);
    callback(null, chunk);
  }

  override _flush(callback: TransformCallback) {
    callback(
      this.receivedBytes === this.expected.size ? null : new ArtifactPartMismatchError('size'),
    );
  }

  /** Call after the stream finished; throws when the declared digest does not match. */
  finishCheck(): { size: number; sha256: string } {
    const sha256 = this.hash.digest('hex');
    if (this.expected.sha256 && this.expected.sha256 !== sha256)
      throw new ArtifactPartMismatchError('sha256');
    return { size: this.receivedBytes, sha256 };
  }
}

/** Returns the parts in assembly order after checking the non-final part minimum. */
export function orderedCompletionParts(
  completion: MultipartCompletion,
  minimumPartBytes: number,
): MultipartCompletion['parts'] {
  const parts = [...completion.parts].sort((left, right) => left.partNumber - right.partNumber);
  parts.slice(0, -1).forEach((part) => {
    if (part.size < minimumPartBytes) throw new ArtifactPartTooSmallError(part.partNumber);
  });
  return parts;
}
