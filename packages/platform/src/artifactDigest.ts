import { createHash } from 'node:crypto';
import { Transform, type TransformCallback } from 'node:stream';

export class ArtifactDigest extends Transform {
  private readonly hash = createHash('sha256');
  private bytes = 0;
  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.bytes += chunk.byteLength;
    this.hash.update(chunk);
    callback(null, chunk);
  }
  finishDigest(): { size: number; sha256: string } {
    return { size: this.bytes, sha256: this.hash.digest('hex') };
  }
}
