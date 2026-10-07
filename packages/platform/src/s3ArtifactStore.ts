import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { PassThrough, Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ArtifactDigest } from './artifactDigest.js';
import { validateArtifactKey } from './artifactKey.js';
import { parseArtifactRange } from './artifactRange.js';
import { ArtifactNotFoundError, type ArtifactStore } from './artifactTypes.js';

// Two 8 MiB parts bound streaming upload memory while supporting multi-GB weights.
const MULTIPART_PART_BYTES = 8 * 1024 * 1024;
const MULTIPART_CONCURRENCY = 2;
function throwStorageError(error: unknown): never {
  if (
    ['NoSuchKey', 'NotFound'].includes((error as Error)?.name) ||
    (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode === 404
  )
    throw new ArtifactNotFoundError();
  throw error;
}
export function createS3ArtifactStore({
  client,
  bucket,
  prefix = '',
}: {
  client: S3Client;
  bucket: string;
  prefix?: string;
}): ArtifactStore {
  function objectKey(key: string): string {
    validateArtifactKey(key);
    return prefix ? `${prefix.replace(/\/$/, '')}/${key}` : key;
  }
  return {
    async put({ key, body, mimeType }) {
      const digest = new ArtifactDigest();
      const uploadBody = new PassThrough();
      const upload = new Upload({
        client,
        params: { Bucket: bucket, Key: objectKey(key), Body: uploadBody, ContentType: mimeType },
        partSize: MULTIPART_PART_BYTES,
        queueSize: MULTIPART_CONCURRENCY,
        leavePartsOnError: false,
      });
      const streaming = pipeline(body, digest, uploadBody);
      try {
        await Promise.all([streaming, upload.done()]);
        return digest.finishDigest();
      } catch (error) {
        uploadBody.destroy();
        body.destroy();
        await Promise.allSettled([streaming, upload.abort()]);
        throwStorageError(error);
      }
    },
    async read({ key, range }) {
      const Key = objectKey(key);
      try {
        const metadata = await client.send(new HeadObjectCommand({ Bucket: bucket, Key }));
        const totalSize = metadata.ContentLength;
        if (totalSize === undefined) throw new Error('Artifact size is unavailable');
        const bytes = parseArtifactRange(range, totalSize);
        const object = await client.send(
          new GetObjectCommand({
            Bucket: bucket,
            Key,
            ...(metadata.ETag ? { IfMatch: metadata.ETag } : {}),
            ...(bytes ? { Range: `bytes=${bytes.start}-${bytes.end}` } : {}),
          }),
        );
        if (!object.Body) throw new ArtifactNotFoundError();
        const body =
          object.Body instanceof Readable
            ? object.Body
            : Readable.from(object.Body as AsyncIterable<Uint8Array>);
        if (!bytes) return { body, size: totalSize, totalSize, status: 200 };
        return {
          body,
          size: bytes.end - bytes.start + 1,
          totalSize,
          status: 206,
          contentRange: `bytes ${bytes.start}-${bytes.end}/${totalSize}`,
        };
      } catch (error) {
        throwStorageError(error);
      }
    },
    async remove(key) {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: objectKey(key) }));
    },
  };
}
