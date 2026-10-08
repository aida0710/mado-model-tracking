import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import {
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ArtifactDigest } from './artifactDigest.js';
import { validateArtifactKey } from './artifactKey.js';
import {
  ArtifactPartCheck,
  ArtifactUploadNotFoundError,
  orderedCompletionParts,
} from './artifactMultipart.js';
import { parseArtifactRange } from './artifactRange.js';
import {
  ArtifactNotFoundError,
  type ArtifactMultipartStore,
  type ArtifactStore,
  type IncompleteMultipartUpload,
} from './artifactTypes.js';

// Artifact keys must start with an alphanumeric character, so this directory never collides.
const MULTIPART_DIRECTORY = '.uploads';
const MULTIPART_METADATA_FILE = 'upload.json';
const BACKEND_UPLOAD_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Staging names written by writeAtKey (whole objects) and putPart (single parts).
const STAGING_FILE_PATTERN =
  /\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(upload|tmp)$/;

function isInsideRoot(filename: string, root: string): boolean {
  const relative = path.relative(root, filename);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
}
function partFilename(directory: string, partNumber: number): string {
  return path.join(directory, `${partNumber}.part`);
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
  /** Writes through a staging file beside the key so readers never see a partial object. */
  async function writeAtKey<T>(key: string, write: (stagingPath: string) => Promise<T>) {
    validateArtifactKey(key);
    const realRoot = await rootPath();
    const filename = path.join(realRoot, key);
    const parent = path.dirname(filename);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    if (!isInsideRoot(await realpath(parent), realRoot))
      throw new Error('Artifact path leaves the configured root');
    const stagingPath = `${filename}.${randomUUID()}.upload`;
    try {
      const written = await write(stagingPath);
      await rename(stagingPath, filename);
      return written;
    } catch (error) {
      await unlink(stagingPath).catch(() => undefined);
      throw error;
    }
  }
  async function multipartDirectory(backendUploadId: string): Promise<string> {
    if (!BACKEND_UPLOAD_ID_PATTERN.test(backendUploadId)) throw new ArtifactUploadNotFoundError();
    const uploadDirectory = path.join(await rootPath(), MULTIPART_DIRECTORY, backendUploadId);
    try {
      if (!(await stat(uploadDirectory)).isDirectory()) throw new ArtifactUploadNotFoundError();
    } catch (error) {
      if (isMissingFile(error)) throw new ArtifactUploadNotFoundError();
      throw error;
    }
    return uploadDirectory;
  }

  const multipart: ArtifactMultipartStore = {
    async createMultipart({ key }) {
      validateArtifactKey(key);
      const backendUploadId = randomUUID();
      const uploadDirectory = path.join(await rootPath(), MULTIPART_DIRECTORY, backendUploadId);
      await mkdir(uploadDirectory, { recursive: true, mode: 0o700 });
      await writeFile(
        path.join(uploadDirectory, MULTIPART_METADATA_FILE),
        JSON.stringify({ key, initiatedAt: new Date().toISOString() }),
        { mode: 0o600 },
      );
      return { backendUploadId };
    },
    async putPart({ backendUploadId, partNumber, body, size, sha256 }) {
      const uploadDirectory = await multipartDirectory(backendUploadId);
      const stagingPath = path.join(uploadDirectory, `${partNumber}.${randomUUID()}.tmp`);
      const check = new ArtifactPartCheck({ size, sha256 });
      try {
        await pipeline(body, check, createWriteStream(stagingPath, { flags: 'wx', mode: 0o600 }));
        const stored = check.finishCheck();
        // A resent part replaces the earlier one only after it has been fully verified.
        await rename(stagingPath, partFilename(uploadDirectory, partNumber));
        return { ...stored, etag: stored.sha256 };
      } catch (error) {
        await unlink(stagingPath).catch(() => undefined);
        throw error;
      }
    },
    async completeMultipart(completion) {
      const uploadDirectory = await multipartDirectory(completion.backendUploadId);
      // The filesystem has no part minimum; the API applies the S3 rule to every backend.
      const parts = orderedCompletionParts(completion, 0);
      for (const part of parts) {
        const stored = await stat(partFilename(uploadDirectory, part.partNumber)).catch(() => null);
        if (stored?.size !== part.size) throw new Error(`Part ${part.partNumber} is not stored`);
      }
      await writeAtKey(completion.key, (stagingPath) =>
        pipeline(
          Readable.from(
            (async function* () {
              for (const part of parts)
                yield* createReadStream(partFilename(uploadDirectory, part.partNumber));
            })(),
          ),
          createWriteStream(stagingPath, { flags: 'wx', mode: 0o600 }),
        ),
      );
      await rm(uploadDirectory, { recursive: true, force: true });
    },
    async abortMultipart({ backendUploadId }) {
      if (!BACKEND_UPLOAD_ID_PATTERN.test(backendUploadId)) return;
      await rm(path.join(await rootPath(), MULTIPART_DIRECTORY, backendUploadId), {
        recursive: true,
        force: true,
      });
    },
    async listIncompleteUploads() {
      const uploadsRoot = path.join(await rootPath(), MULTIPART_DIRECTORY);
      const entries = await readdir(uploadsRoot).catch((error: unknown) => {
        if (isMissingFile(error)) return [];
        throw error;
      });
      const uploads: IncompleteMultipartUpload[] = [];
      for (const backendUploadId of entries.filter((entry) =>
        BACKEND_UPLOAD_ID_PATTERN.test(entry),
      )) {
        const metadataPath = path.join(uploadsRoot, backendUploadId, MULTIPART_METADATA_FILE);
        try {
          const metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as {
            key: string;
            initiatedAt: string;
          };
          uploads.push({
            ...metadata,
            backendUploadId,
            initiatedAt: new Date(metadata.initiatedAt),
          });
        } catch {
          // A crash between mkdir and the metadata write leaves an unnamed directory; age it by mtime.
          const created = await stat(path.join(uploadsRoot, backendUploadId)).catch(() => null);
          if (created) uploads.push({ key: '', backendUploadId, initiatedAt: created.mtime });
        }
      }
      return uploads;
    },
    async removeAbandonedStaging(notModifiedSince) {
      const realRoot = await rootPath();
      const entries = await readdir(realRoot, { recursive: true, withFileTypes: true });
      let removed = 0;
      for (const entry of entries) {
        if (!entry.isFile() || !STAGING_FILE_PATTERN.test(entry.name)) continue;
        const filename = path.join(entry.parentPath, entry.name);
        const metadata = await stat(filename).catch(() => null);
        if (!metadata || metadata.mtime >= notModifiedSince) continue;
        await unlink(filename).catch(() => undefined);
        removed++;
      }
      return removed;
    },
  };

  return {
    async put({ key, body }) {
      const digest = new ArtifactDigest();
      return writeAtKey(key, async (stagingPath) => {
        await pipeline(body, digest, createWriteStream(stagingPath, { flags: 'wx', mode: 0o600 }));
        return digest.finishDigest();
      });
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
    multipart,
  };
}
