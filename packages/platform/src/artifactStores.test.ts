import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ArtifactBackendDisabledError, createReplaceableArtifactStores } from './artifactStores.js';
import { createFilesystemArtifactStore } from './filesystemArtifactStore.js';
import { ArtifactBackendError, type ArtifactStore } from './artifactTypes.js';

async function text(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString();
}

describe('差し替え可能なArtifactStores', () => {
  let directory: string;
  let first: ArtifactStore;
  let second: ArtifactStore;
  beforeAll(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'mmt-replaceable-stores-'));
    first = createFilesystemArtifactStore(path.join(directory, 'first'));
    second = createFilesystemArtifactStore(path.join(directory, 'second'));
  });
  afterAll(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('差し替え後の呼び出しは新しいstoreへ行き、差し替え前に始めたputは古いstoreで完了する', async () => {
    const stores = createReplaceableArtifactStores({
      archive: { store: first, acceptsWrites: true },
    });
    let releaseBody!: () => void;
    const bodyReleased = new Promise<void>((resolve) => {
      releaseBody = resolve;
    });
    const slowBody = Readable.from(
      (async function* () {
        yield Buffer.from('old-');
        await bodyReleased;
        yield Buffer.from('store');
      })(),
    );
    const inProgress = stores.put({
      backend: 'archive',
      key: 'p/slow',
      body: slowBody,
      mimeType: 'text/plain',
    });
    stores.replace('archive', { store: second, acceptsWrites: true });
    releaseBody();
    await inProgress;
    expect(await text((await first.read({ key: 'p/slow' })).body)).toBe('old-store');
    await stores.put({
      backend: 'archive',
      key: 'p/new',
      body: Readable.from([Buffer.from('new')]),
      mimeType: 'text/plain',
    });
    expect(await text((await second.read({ key: 'p/new' })).body)).toBe('new');
  });

  it('書き込み停止中のbackendは読めるがputと新しいmultipartを拒否する', async () => {
    await first.put({
      key: 'p/kept',
      body: Readable.from([Buffer.from('kept')]),
      mimeType: 'text/plain',
    });
    const stores = createReplaceableArtifactStores({
      archive: { store: first, acceptsWrites: false },
    });
    expect(stores.backends()).toEqual(['archive']);
    expect(stores.writableBackends()).toEqual([]);
    expect(await text((await stores.read({ backend: 'archive', key: 'p/kept' })).body)).toBe(
      'kept',
    );
    await expect(
      stores.put({
        backend: 'archive',
        key: 'p/refused',
        body: Readable.from([Buffer.from('x')]),
        mimeType: 'text/plain',
      }),
    ).rejects.toBeInstanceOf(ArtifactBackendDisabledError);
    await expect(
      stores.multipart('archive')!.createMultipart({ key: 'p/refused', mimeType: 'text/plain' }),
    ).rejects.toBeInstanceOf(ArtifactBackendDisabledError);
  });

  it('未登録・削除済みのbackendはArtifactBackendErrorになる', async () => {
    const stores = createReplaceableArtifactStores({
      archive: { store: first, acceptsWrites: true },
    });
    stores.delete('archive');
    await expect(stores.read({ backend: 'archive', key: 'p/kept' })).rejects.toBeInstanceOf(
      ArtifactBackendError,
    );
    expect(() => stores.multipart('archive')).toThrow(ArtifactBackendError);
  });
});
