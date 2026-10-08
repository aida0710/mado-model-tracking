import { Transform, type TransformCallback } from 'node:stream';
import { DomainError } from '../domain/errors.js';

export function artifactTooLargeError(maxBytes: number): DomainError {
  return new DomainError(
    413,
    `Artifactの上限サイズ（${maxBytes} bytes）を超えています`,
    'artifact_too_large',
  );
}

/** Rejects a declared Content-Length before any byte is written to storage. */
export function assertDeclaredArtifactSize(declaredBytes: number | undefined, maxBytes: number) {
  if (declaredBytes !== undefined && declaredBytes > maxBytes)
    throw artifactTooLargeError(maxBytes);
}

/**
 * Passes bytes through until the limit, then fails the stream so the storage pipeline aborts.
 * Chunked uploads have no Content-Length, so this is the only bound on them.
 */
export class ArtifactSizeLimit extends Transform {
  private receivedBytes = 0;
  isExceeded = false;

  constructor(private readonly maxBytes: number) {
    super();
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
    this.receivedBytes += chunk.length;
    if (this.receivedBytes > this.maxBytes) {
      this.isExceeded = true;
      callback(artifactTooLargeError(this.maxBytes));
      return;
    }
    callback(null, chunk);
  }
}
