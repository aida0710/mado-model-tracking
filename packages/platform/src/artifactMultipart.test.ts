import {
  CreateBucketCommand,
  DeleteBucketCommand,
  ListMultipartUploadsCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  ArtifactPartMismatchError,
  ArtifactPartTooSmallError,
  ArtifactUploadNotFoundError,
  MULTIPART_MIN_PART_BYTES,
} from './artifactMultipart.js';
import { ArtifactNotFoundError, type ArtifactMultipartStore } from './artifactTypes.js';
import { createFilesystemArtifactStore } from './filesystemArtifactStore.js';
import { createS3ArtifactStore } from './s3ArtifactStore.js';

const directories: string[] = [];
async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mmt-multipart-'));
  directories.push(directory);
  return directory;
}
async function contents(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}
function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}
async function putBytes(
  multipart: ArtifactMultipartStore,
  upload: { key: string; backendUploadId: string },
  partNumber: number,
  bytes: Buffer,
) {
  return multipart.putPart({
    ...upload,
    partNumber,
    body: Readable.from([bytes]),
    size: bytes.length,
    sha256: sha256(bytes),
  });
}
async function filesUnder(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(directory, path.join(entry.parentPath, entry.name)));
}
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('filesystemの再開可能upload', () => {
  it('partを順不同・再送で受け取っても、part番号順に連結したobjectを作る', async () => {
    const directory = await temporaryDirectory();
    const store = createFilesystemArtifactStore(directory);
    const multipart = store.multipart!;
    const key = 'p/a/content';
    const upload = { key, ...(await multipart.createMultipart({ key, mimeType: 'audio/wav' })) };
    const chunks = [Buffer.from('first-'), Buffer.from('second-'), Buffer.from('third')];
    const third = await putBytes(multipart, upload, 3, chunks[2]!);
    await putBytes(multipart, upload, 1, Buffer.from('broken'));
    const first = await putBytes(multipart, upload, 1, chunks[0]!);
    const second = await putBytes(multipart, upload, 2, chunks[1]!);
    expect(first).toEqual({ size: 6, sha256: sha256(chunks[0]!), etag: sha256(chunks[0]!) });

    await multipart.completeMultipart({
      ...upload,
      parts: [
        { partNumber: 3, size: chunks[2]!.length, etag: third.etag },
        { partNumber: 1, size: chunks[0]!.length, etag: first.etag },
        { partNumber: 2, size: chunks[1]!.length, etag: second.etag },
      ],
    });

    expect(await contents((await store.read({ key })).body)).toEqual(Buffer.concat(chunks));
    expect(await filesUnder(directory)).toEqual([key]);
    expect(await multipart.listIncompleteUploads()).toEqual([]);
    await expect(multipart.completeMultipart({ ...upload, parts: [] })).rejects.toBeInstanceOf(
      ArtifactUploadNotFoundError,
    );
  });

  it('宣言と長さ・SHA-256が違うpartは保存せず、前に受け取ったpartを残す', async () => {
    const directory = await temporaryDirectory();
    const multipart = createFilesystemArtifactStore(directory).multipart!;
    const key = 'p/a/content';
    const upload = { key, ...(await multipart.createMultipart({ key, mimeType: 'text/plain' })) };
    await putBytes(multipart, upload, 1, Buffer.from('good'));
    await expect(
      multipart.putPart({ ...upload, partNumber: 1, body: Readable.from(['bad']), size: 4 }),
    ).rejects.toMatchObject({ mismatch: 'size' });
    await expect(
      multipart.putPart({ ...upload, partNumber: 1, body: Readable.from(['toolong']), size: 4 }),
    ).rejects.toMatchObject({ mismatch: 'size' });
    await expect(
      multipart.putPart({
        ...upload,
        partNumber: 1,
        body: Readable.from(['evil']),
        size: 4,
        sha256: sha256(Buffer.from('good')),
      }),
    ).rejects.toBeInstanceOf(ArtifactPartMismatchError);
    expect((await filesUnder(directory)).sort()).toEqual([
      `.uploads/${upload.backendUploadId}/1.part`,
      `.uploads/${upload.backendUploadId}/upload.json`,
    ]);
  });

  it('abortすると受け取ったpartも作業ディレクトリも残らない', async () => {
    const directory = await temporaryDirectory();
    const store = createFilesystemArtifactStore(directory);
    const multipart = store.multipart!;
    const key = 'p/a/content';
    const upload = { key, ...(await multipart.createMultipart({ key, mimeType: 'text/plain' })) };
    await putBytes(multipart, upload, 1, Buffer.from('part'));
    expect(await multipart.listIncompleteUploads()).toEqual([
      expect.objectContaining({ key, backendUploadId: upload.backendUploadId }),
    ]);

    await multipart.abortMultipart(upload);
    await multipart.abortMultipart(upload);

    expect(await filesUnder(directory)).toEqual([]);
    await expect(putBytes(multipart, upload, 2, Buffer.from('late'))).rejects.toBeInstanceOf(
      ArtifactUploadNotFoundError,
    );
    await expect(store.read({ key })).rejects.toBeInstanceOf(ArtifactNotFoundError);
  });

  it('更新の止まった書きかけのstagingだけを消し、書き込み中と保存済みのobjectは残す', async () => {
    const directory = await temporaryDirectory();
    const store = createFilesystemArtifactStore(directory);
    await store.put({ key: 'p/a/content', body: Readable.from(['kept']), mimeType: 'text/plain' });
    const abandoned = path.join(directory, `p/a/content.${randomUUID()}.upload`);
    const active = path.join(directory, `p/b.${randomUUID()}.upload`);
    await writeFile(abandoned, 'partial');
    await writeFile(active, 'partial');
    const longAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    await utimes(abandoned, longAgo, longAgo);

    expect(
      await store.multipart!.removeAbandonedStaging(new Date(Date.now() - 24 * 60 * 60 * 1000)),
    ).toBe(1);
    expect((await filesUnder(directory)).sort()).toEqual(
      ['p/a/content', path.relative(directory, active)].sort(),
    );
  });
});

const endpoint = process.env.MMT_TEST_S3_ENDPOINT;
describe.skipIf(!endpoint)('S3の再開可能upload（S3 emulator）', () => {
  const bucket = `mmt-test-${randomUUID()}`;
  const client = new S3Client({
    endpoint,
    region: 'us-east-1',
    forcePathStyle: true,
    // These values authenticate only to the isolated emulator, never to real storage.
    credentials: { accessKeyId: 'testing', secretAccessKey: 'testing' },
  });
  const store = createS3ArtifactStore({ client, bucket, prefix: 'artifacts' });
  const multipart = store.multipart!;
  async function pendingUploads(): Promise<number> {
    const listed = await client.send(new ListMultipartUploadsCommand({ Bucket: bucket }));
    return listed.Uploads?.length ?? 0;
  }
  beforeAll(async () => {
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
  });
  afterAll(async () => {
    await client.send(new DeleteBucketCommand({ Bucket: bucket }));
    client.destroy();
  });

  it('partを順不同・再送で受け取ってもcompleteで1つのobjectになる', async () => {
    const key = 'p/assembled/content';
    const upload = { key, ...(await multipart.createMultipart({ key, mimeType: 'audio/wav' })) };
    const first = Buffer.alloc(MULTIPART_MIN_PART_BYTES, 'a');
    const last = Buffer.from('tail');
    const lastPart = await putBytes(multipart, upload, 2, last);
    await putBytes(multipart, upload, 1, Buffer.alloc(MULTIPART_MIN_PART_BYTES, 'x'));
    const firstPart = await putBytes(multipart, upload, 1, first);
    expect(await multipart.listIncompleteUploads()).toEqual([
      expect.objectContaining({ key, backendUploadId: upload.backendUploadId }),
    ]);

    await multipart.completeMultipart({
      ...upload,
      parts: [
        { partNumber: 2, size: last.length, etag: lastPart.etag },
        { partNumber: 1, size: first.length, etag: firstPart.etag },
      ],
    });
    try {
      expect(sha256(await contents((await store.read({ key })).body))).toBe(
        sha256(Buffer.concat([first, last])),
      );
      expect(await pendingUploads()).toBe(0);
    } finally {
      await store.remove(key);
    }
  });

  it('最後以外のpartが5MiB未満ならcompleteを拒否し、abortでpartを残さない', async () => {
    const key = 'p/too-small/content';
    const upload = { key, ...(await multipart.createMultipart({ key, mimeType: 'text/plain' })) };
    const small = await putBytes(multipart, upload, 1, Buffer.from('small'));
    const last = await putBytes(multipart, upload, 2, Buffer.from('last'));
    await expect(
      multipart.completeMultipart({
        ...upload,
        parts: [
          { partNumber: 1, size: 5, etag: small.etag },
          { partNumber: 2, size: 4, etag: last.etag },
        ],
      }),
    ).rejects.toBeInstanceOf(ArtifactPartTooSmallError);

    await multipart.abortMultipart(upload);
    await multipart.abortMultipart(upload);
    expect(await pendingUploads()).toBe(0);
    await expect(store.read({ key })).rejects.toBeInstanceOf(ArtifactNotFoundError);
  });

  it('宣言より短いpartは送信を止めて失敗にする', async () => {
    const key = 'p/short/content';
    const upload = { key, ...(await multipart.createMultipart({ key, mimeType: 'text/plain' })) };
    try {
      await expect(
        multipart.putPart({ ...upload, partNumber: 1, body: Readable.from(['abc']), size: 10 }),
      ).rejects.toBeDefined();
    } finally {
      await multipart.abortMultipart(upload);
    }
  });

  it('単一のputが途中で失敗したら、rejectする前にmultipart uploadをabortし終えている', async () => {
    const upload = Readable.from(
      (async function* () {
        yield Buffer.alloc(10 * 1024 * 1024, 'x');
        throw new Error('upload interrupted');
      })(),
    );
    await expect(
      store.put({ key: 'p/broken', body: upload, mimeType: 'application/octet-stream' }),
    ).rejects.toThrow('upload interrupted');
    expect(await pendingUploads()).toBe(0);
  });
});
