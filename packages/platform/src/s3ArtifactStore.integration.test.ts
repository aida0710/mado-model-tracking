import { CreateBucketCommand, DeleteBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createS3ArtifactStore } from './s3ArtifactStore.js';
import { ArtifactNotFoundError, ArtifactRangeError } from './artifactTypes.js';

const endpoint = process.env.MMT_TEST_S3_ENDPOINT;
const bucket = `mmt-test-${randomUUID()}`;
const client = new S3Client({
  endpoint,
  region: 'us-east-1',
  forcePathStyle: true,
  // These values authenticate only to the isolated emulator, never to real storage.
  credentials: { accessKeyId: 'testing', secretAccessKey: 'testing' },
});
const store = createS3ArtifactStore({ client, bucket, prefix: 'artifacts' });
async function contents(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

describe.skipIf(!endpoint)('S3 protocol integration', () => {
  beforeAll(async () => {
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
  });
  afterAll(async () => {
    await client.send(new DeleteBucketCommand({ Bucket: bucket }));
    client.destroy();
  });

  it('stores a multipart stream, preserves its digest and supports media seeking', async () => {
    // More than two upload parts forces multipart protocol rather than a small PUT.
    const part = Buffer.alloc(1024 * 1024, 'weights');
    const chunks = Array.from({ length: 18 }, () => part);
    const expectedDigest = createHash('sha256');
    chunks.forEach((chunk) => expectedDigest.update(chunk));
    const written = await store.put({
      key: 'p/weights',
      body: Readable.from(chunks),
      mimeType: 'application/octet-stream',
    });
    try {
      expect(written).toEqual({
        size: part.length * chunks.length,
        sha256: expectedDigest.digest('hex'),
      });
      const selected = await store.read({ key: 'p/weights', range: 'bytes=1048570-1048580' });
      expect(selected).toMatchObject({
        status: 206,
        size: 11,
        contentRange: `bytes 1048570-1048580/${written.size}`,
      });
      expect(await contents(selected.body)).toEqual(
        Buffer.concat(chunks.slice(0, 2)).subarray(1048570, 1048581),
      );
      await expect(
        store.read({ key: 'p/weights', range: `bytes=${written.size}-` }),
      ).rejects.toBeInstanceOf(ArtifactRangeError);
    } finally {
      await store.remove('p/weights');
    }
    await expect(store.read({ key: 'p/weights' })).rejects.toBeInstanceOf(ArtifactNotFoundError);
  });

  it('aborts an interrupted multipart stream without exposing a partial object', async () => {
    const upload = Readable.from(
      (async function* () {
        yield Buffer.alloc(10 * 1024 * 1024, 'x');
        throw new Error('upload interrupted');
      })(),
    );
    await expect(
      store.put({ key: 'p/broken', body: upload, mimeType: 'application/octet-stream' }),
    ).rejects.toThrow('upload interrupted');
    await expect(store.read({ key: 'p/broken' })).rejects.toBeInstanceOf(ArtifactNotFoundError);
  });
});
