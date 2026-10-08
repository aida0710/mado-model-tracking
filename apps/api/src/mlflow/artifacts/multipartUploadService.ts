import type { Readable } from 'node:stream';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import type { Artifact, User } from '@mmt/contracts';
import type { ArtifactStores } from '@mmt/platform';
import { first, transaction, type Connection, type Database } from '../../db/database.js';
import { DomainError } from '../../domain/errors.js';
import { userColumns } from '../../repositories/identityRepository.js';
import type { ArtifactUploadRecord } from '../../repositories/artifactUploadRepository.js';
import type { ArtifactUploadRegisteredHook } from '../../services/artifactUploadFinalizer.js';
import type { ArtifactUploadService } from '../../services/artifactUploadService.js';
import { requireArtifactOwner, requireArtifactProject } from './artifactAccess.js';
import { nativeArtifactPath, validateArtifactOwner } from './artifactPath.js';
import {
  replaceArtifactPath,
  requireNonconflictingArtifactPath,
} from './artifactPathRepository.js';
import type { ArtifactAccess, ArtifactLocation, ArtifactOwner } from './artifactTypes.js';
import {
  MAX_MLMODEL_METADATA_BYTES,
  MlmodelCapture,
  saveLoggedModelMlmodel,
} from './mlmodelCapture.js';
import { partEtag } from './multipartProtocol.js';
import { MultipartUploadUnsupportedError } from './multipartUnsupported.js';

// The finalizer polls every second, so a shorter interval only adds queries.
const FINALIZE_POLL_MS = 250;

type MultipartAccess = ArtifactAccess & { path: string };
type WritableOwner = { kind: 'run' | 'model'; id: string };

/**
 * MLflow's proxied multipart upload (mpu/create, part PUT, complete, abort) on top of artifact
 * upload sessions. The session holds the Artifact path owner; when the finalizer registers the
 * Artifact, mapRegisteredArtifact maps the MLflow path to it in the same transaction.
 */
export class MlflowMultipartUploadService {
  constructor(
    private readonly options: {
      database: Database;
      stores: ArtifactStores;
      uploads: ArtifactUploadService;
      /** MMT_UPLOAD_FINALIZE_WAIT_MS: complete answers 503 when verification takes longer. */
      finalizeWaitMs: number;
    },
  ) {}

  async create(
    request: MultipartAccess & { partCount: number },
  ): Promise<{ uploadId: string; partToken: string; partCount: number }> {
    const location = writableLocation(request);
    // An empty file has no parts; the SDK sends it as a plain PUT after this answer.
    if (request.partCount === 0) throw new MultipartUploadUnsupportedError();
    const nativePath = nativeArtifactPath(location);
    const authorized = await transaction(this.options.database, async (connection) => {
      const identity = await requireArtifactProject(connection, location, {
        write: true,
        lock: true,
      });
      const owner = await requireArtifactOwner(connection, location, { write: true, lock: true });
      await requireNonconflictingArtifactPath(connection, location);
      return { identity, runId: owner.runId };
    });
    try {
      const { upload, partToken } = await this.options.uploads.createOwned(
        authorized.identity,
        location.projectId,
        {
          path: nativePath,
          runId: authorized.runId,
          partCount: request.partCount,
          owner: location.owner,
        },
      );
      return { uploadId: upload.id, partToken, partCount: upload.partCount };
    } catch (error) {
      if (error instanceof DomainError && error.code === 'multipart_unsupported')
        throw new MultipartUploadUnsupportedError();
      throw error;
    }
  }

  /** Authorized by the part token alone: the SDK sends part requests without Authorization. */
  async uploadPart(part: {
    projectId: string;
    uploadId: string;
    partNumber: number;
    partToken: string | undefined;
    declaredBytes?: number;
    body: Readable;
  }): Promise<{ etag: string }> {
    const stored = await this.options.uploads.putPartWithToken(part.projectId, part);
    return { etag: partEtag(stored.sha256) };
  }

  /**
   * MLflow treats complete as synchronous: the file must be listable when it returns. This waits
   * for the finalizer, which may run in another API process, to register the Artifact.
   */
  async complete(
    request: MultipartAccess & {
      uploadId: string;
      parts: { partNumber: number; sha256: string | null }[];
    },
  ): Promise<void> {
    const location = writableLocation(request);
    const upload = await this.options.uploads.completeOwned(request.principal, location.projectId, {
      uploadId: request.uploadId,
      parts: request.parts,
      authorize: async (connection, session) => {
        assertSessionTarget(session, location);
        await requireArtifactProject(connection, location, { write: true, lock: true });
        const owner = await requireArtifactOwner(connection, location, { write: true, lock: true });
        if (owner.runId !== session.runId)
          throw new DomainError(409, 'Artifactのsource Runが変更されました', 'conflict');
        await requireNonconflictingArtifactPath(connection, location);
      },
    });
    // A retried complete skips authorize; it must still name the session's own target.
    assertSessionTarget(upload, location);
    await this.waitUntilRegistered(location.projectId, upload.id);
  }

  async abort(request: ArtifactAccess & { uploadId: string }): Promise<void> {
    await this.options.uploads.abortOwned(request.principal, request.projectId, request.uploadId);
  }

  /** Finalizer hook: maps the MLflow path in the transaction that registers the Artifact. */
  readonly mapRegisteredArtifact: ArtifactUploadRegisteredHook = async (
    connection,
    upload,
    artifact,
  ) => {
    if (!upload.ownerKind || !upload.ownerId) return;
    const owner: WritableOwner = { kind: upload.ownerKind, id: upload.ownerId };
    const creator = await first<User>(
      connection,
      `SELECT ${userColumns} FROM users u WHERE u.id=$1`,
      [upload.createdByUserId],
    );
    // The owner checks read only the owner; the creator's access was checked at complete.
    const access: MultipartAccess = {
      principal: { user: creator!, method: 'session', token: null },
      projectId: upload.projectId,
      owner,
      path: mlflowArtifactPath(upload.path, owner),
    };
    // Throwing keeps the session verifying; the finalizer retries and finally marks it failed.
    const { runId } = await requireArtifactOwner(connection, access, { write: true, lock: true });
    if (runId !== upload.runId)
      throw new DomainError(409, 'Artifactのsource Runが変更されました', 'conflict');
    await requireNonconflictingArtifactPath(connection, access);
    await replaceArtifactPath(connection, { ...access, artifact, runId });
    if (owner.kind === 'model' && access.path === 'MLmodel')
      await saveLoggedModelMlmodel(connection, {
        projectId: upload.projectId,
        id: owner.id,
        metadata: await this.readMlmodel(upload, artifact),
      });
  };

  private async readMlmodel(
    upload: ArtifactUploadRecord,
    artifact: Artifact,
  ): Promise<Record<string, unknown> | null> {
    // Same rule as single PUTs: an oversized MLmodel is stored without captured metadata.
    if (artifact.size > MAX_MLMODEL_METADATA_BYTES) return null;
    const content = await this.options.stores.read({
      backend: upload.backend,
      key: upload.storageKey,
    });
    const capture = new MlmodelCapture();
    const discard = new Writable({ write: (_chunk, _encoding, callback) => callback() });
    await pipeline(content.body, capture, discard);
    return capture.metadata();
  }

  private async waitUntilRegistered(projectId: string, uploadId: string): Promise<void> {
    const deadline = Date.now() + this.options.finalizeWaitMs;
    for (;;) {
      const session = await first<{ status: string; error: string | null }>(
        this.options.database,
        'SELECT status,error FROM artifact_uploads WHERE project_id=$1 AND id=$2',
        [projectId, uploadId],
      );
      if (session?.status === 'completed') return;
      if (session?.status === 'failed') throw finalizeFailure(session.error);
      if (session?.status !== 'verifying')
        throw new DomainError(409, 'このupload sessionは完了できません', 'upload_not_open');
      if (Date.now() >= deadline)
        throw new DomainError(
          503,
          'Artifactの検証が続いています。完了後に一覧へ表示されます',
          'upload_finalize_pending',
        );
      await delay(FINALIZE_POLL_MS);
    }
  }
}

function writableLocation<T extends MultipartAccess>(request: T): T & { owner: WritableOwner } {
  const owner = validateArtifactOwner(request.owner);
  if (owner.kind === 'model-version')
    throw new DomainError(409, '登録モデル版のArtifactは変更できません', 'conflict');
  return { ...request, owner: { kind: owner.kind, id: owner.id } };
}

/** The Artifact path relative to its MLflow owner; Logged Model files live under models/<id>/. */
function mlflowArtifactPath(nativePath: string, owner: ArtifactOwner): string {
  return owner.kind === 'model' ? nativePath.slice(`models/${owner.id}/`.length) : nativePath;
}

function assertSessionTarget(upload: ArtifactUploadRecord, location: ArtifactLocation): void {
  if (
    upload.ownerKind !== location.owner.kind ||
    upload.ownerId !== location.owner.id ||
    upload.path !== nativeArtifactPath(location)
  )
    throw new DomainError(
      422,
      'upload_idと保存先のArtifactパスが一致しません',
      'invalid_parameter_value',
    );
}

function finalizeFailure(error: string | null): DomainError {
  switch (error) {
    case 'size_mismatch':
    case 'sha256_mismatch':
      return new DomainError(422, '受け取ったpartを結合した内容を検証できませんでした', error);
    case 'part_too_small':
      return new DomainError(422, '最後以外のpartが保存先の最小サイズ未満です', error);
    case 'run_deleted':
      return new DomainError(409, '削除済みRunにはArtifactを登録できません', error);
    default:
      return new DomainError(503, 'Artifactの登録に失敗しました', 'artifact_save_failed');
  }
}
