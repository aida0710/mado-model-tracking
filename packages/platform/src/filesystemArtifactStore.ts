import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, realpath, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { ArtifactDigest } from './artifactDigest.js';
import { validateArtifactKey } from './artifactKey.js';
import { parseArtifactRange } from './artifactRange.js';
import { ArtifactNotFoundError, type ArtifactStore } from './artifactTypes.js';

function isInsideRoot(filename: string, root: string): boolean {
  const relative = path.relative(root, filename);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
}

export function createFilesystemArtifactStore(directory: string): ArtifactStore {
  const root = path.resolve(directory);
  async function rootPath(): Promise<string> {
    await mkdir(root, { recursive: true, mode: 0o700 });
    return realpath(root);
  }
  async function existingPath(key: string): Promise<string> {
    validateArtifactKey(key);
    try {
      const realRoot = await rootPath();
      const filename = await realpath(path.join(realRoot, key));
      if (!isInsideRoot(filename, realRoot))
        throw new Error('Artifact path leaves the configured root');
      return filename;
    } catch (error) {
      if (isMissingFile(error)) throw new ArtifactNotFoundError();
      throw error;
    }
  }
  return {
    async put({ key, body }) {
      validateArtifactKey(key);
      const realRoot = await rootPath();
      const filename = path.join(realRoot, key);
      const parent = path.dirname(filename);
      await mkdir(parent, { recursive: true, mode: 0o700 });
      if (!isInsideRoot(await realpath(parent), realRoot))
        throw new Error('Artifact path leaves the configured root');
      const stagingPath = `${filename}.${randomUUID()}.upload`;
      const digest = new ArtifactDigest();
      try {
        await pipeline(body, digest, createWriteStream(stagingPath, { flags: 'wx', mode: 0o600 }));
        await rename(stagingPath, filename);
        return digest.finishDigest();
      } catch (error) {
        await unlink(stagingPath).catch(() => undefined);
        throw error;
      }
    },
    async read({ key, range }) {
      const filename = await existingPath(key);
      const metadata = await stat(filename);
      if (!metadata.isFile()) throw new ArtifactNotFoundError();
      const bytes = parseArtifactRange(range, metadata.size);
      if (!bytes)
        return {
          body: createReadStream(filename),
          size: metadata.size,
          totalSize: metadata.size,
          status: 200,
        };
      return {
        body: createReadStream(filename, bytes),
        size: bytes.end - bytes.start + 1,
        totalSize: metadata.size,
        status: 206,
        contentRange: `bytes ${bytes.start}-${bytes.end}/${metadata.size}`,
      };
    },
    async remove(key) {
      const filename = await existingPath(key).catch((error) => {
        if (error instanceof ArtifactNotFoundError) return null;
        throw error;
      });
      if (filename) await unlink(filename);
    },
  };
}
