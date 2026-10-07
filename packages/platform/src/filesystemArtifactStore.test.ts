import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { createFilesystemArtifactStore } from './filesystemArtifactStore.js';
import { ArtifactNotFoundError, ArtifactRangeError } from './artifactTypes.js';

const directories: string[] = [];
async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mmt-artifacts-'));
  directories.push(directory);
  return directory;
}
async function contents(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
describe('filesystem Artifacts', () => {
  it('streams an upload and reports the digest of exactly the stored bytes', async () => {
    const directory = await temporaryDirectory();
    const store = createFilesystemArtifactStore(directory);
    const bytes = Buffer.from('model-weights-0123456789');
    const stored = await store.put({
      key: 'project/model',
      body: Readable.from([bytes.subarray(0, 4), bytes.subarray(4)]),
      mimeType: 'application/octet-stream',
    });
    expect(stored).toEqual({
      size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
    expect(await contents((await store.read({ key: 'project/model' })).body)).toEqual(bytes);
  });
  it('returns only the requested bytes for media seek and suffix requests', async () => {
    const store = createFilesystemArtifactStore(await temporaryDirectory());
    await store.put({ key: 'p/audio', body: Readable.from(['0123456789']), mimeType: 'audio/wav' });
    const selected = await store.read({ key: 'p/audio', range: 'bytes=2-5' });
    expect(selected).toMatchObject({
      status: 206,
      size: 4,
      totalSize: 10,
      contentRange: 'bytes 2-5/10',
    });
    expect((await contents(selected.body)).toString()).toBe('2345');
    expect(
      (await contents((await store.read({ key: 'p/audio', range: 'bytes=-3' })).body)).toString(),
    ).toBe('789');
    await expect(store.read({ key: 'p/audio', range: 'bytes=10-' })).rejects.toBeInstanceOf(
      ArtifactRangeError,
    );
  });
  it('does not leave a partial Artifact after its upload stream fails', async () => {
    const directory = await temporaryDirectory();
    const store = createFilesystemArtifactStore(directory);
    const upload = Readable.from(
      (async function* () {
        yield Buffer.from('partial');
        throw new Error('network interrupted');
      })(),
    );
    await expect(
      store.put({ key: 'p/broken', body: upload, mimeType: 'application/octet-stream' }),
    ).rejects.toThrow('network interrupted');
    expect(await readdir(path.join(directory, 'p'))).toEqual([]);
    await expect(store.read({ key: 'p/broken' })).rejects.toBeInstanceOf(ArtifactNotFoundError);
  });
  it('rejects storage traversal and does not follow a symlink outside the root', async () => {
    const directory = await temporaryDirectory();
    const outside = await temporaryDirectory();
    const store = createFilesystemArtifactStore(directory);
    await expect(
      store.put({ key: '../escape', body: Readable.from(['x']), mimeType: 'text/plain' }),
    ).rejects.toThrow('Invalid Artifact storage key');
    await writeFile(path.join(outside, 'private'), 'private');
    await symlink(path.join(outside, 'private'), path.join(directory, 'linked'));
    await expect(store.read({ key: 'linked' })).rejects.toThrow('leaves the configured root');
  });
});
