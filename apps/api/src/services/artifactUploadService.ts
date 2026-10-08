import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import type {
  ArtifactBackend,
  ArtifactUpload,
  ArtifactUploadCreate,
  ArtifactUploadDetail,
  ArtifactUploadPart,
  ArtifactUploadStatus,
} from '@mmt/contracts';
import {
  ArtifactPartMismatchError,
  ArtifactUploadNotFoundError,
  MULTIPART_MAX_PART_BYTES,
  MULTIPART_MAX_PART_COUNT,
  MULTIPART_MIN_PART_BYTES,
  type ArtifactMultipartStore,
  type ArtifactStores,
} from '@mmt/platform';
import type { Principal } from '../auth/principal.js';
import { first, rows, transaction, type Connection, type Database } from '../db/database.js';
import { resolveArtifactMimeType } from '../domain/artifactMimeType.js';
import { DomainError } from '../domain/errors.js';
import {
  artifactUploadColumns,
  expectedPartBytes,
  findArtifactUpload,
  listArtifactUploadParts,
  publicArtifactUpload,
  runLifecycleStage,
  type ArtifactUploadRecord,
} from '../repositories/artifactUploadRepository.js';
import { requireProject } from './accessService.js';
import { assertArtifactPath, projectArtifactBackend } from './artifactRegistration.js';
import { artifactTooLargeError } from './artifactSizeLimit.js';
import type { ArtifactLimits } from './artifactService.js';

// Large enough that a 200 GiB Artifact fits in the 10000-part limit with headroom, small enough
// that resending one failed part over a slow link takes seconds rather than minutes.
export const DEFAULT_UPLOAD_PART_BYTES = 16 * 1024 * 1024;
// Adopted decision (2026-10-08): an unfinished session keeps its parts for 7 days.
export const UPLOAD_SESSION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

const PERMISSION = { role: 'editor', scope: 'artifacts:write' } as const;

export class ArtifactUploadService {
  constructor(
    private readonly database: Database,
    private readonly stores: ArtifactStores,
    private readonly limits: ArtifactLimits,
  ) {}

  async create(
    principal: Principal,
    projectId: string,
    input: ArtifactUploadCreate,
  ): Promise<ArtifactUpload> {
    await requireProject(this.database, principal, { projectId, ...PERMISSION });
    assertArtifactPath(input.path);
    if (input.expectedSize > this.limits.maxBytes)
      throw artifactTooLargeError(this.limits.maxBytes);
    const partSize = input.partSize ?? DEFAULT_UPLOAD_PART_BYTES;
    if (partSize < MULTIPART_MIN_PART_BYTES || partSize > MULTIPART_MAX_PART_BYTES)
      throw new DomainError(
        422,
        `partSizeは${MULTIPART_MIN_PART_BYTES}〜${MULTIPART_MAX_PART_BYTES} bytesにしてください`,
        'invalid_part_size',
      );
    const partCount = Math.ceil(input.expectedSize / partSize);
    if (partCount > MULTIPART_MAX_PART_COUNT)
      throw new DomainError(
        422,
        `part数が上限${MULTIPART_MAX_PART_COUNT}を超えます。partSizeを大きくしてください`,
        'too_many_parts',
      );
    if (input.runId) await assertRunAcceptsArtifacts(this.database, projectId, input.runId);
    const backend = await projectArtifactBackend(this.database, projectId, this.stores);
    const multipart = this.multipartStore(backend);
    const id = randomUUID();
    // The Artifact registered on completion reuses this id, so the key matches single uploads.
    const storageKey = `${projectId}/${id}/content`;
    const mimeType = resolveArtifactMimeType({
      path: input.path,
      declaredMimeType: input.mimeType,
    });
    const { backendUploadId } = await multipart.createMultipart({ key: storageKey, mimeType });
    try {
      const upload = (await first<ArtifactUploadRecord>(
        this.database,
        `INSERT INTO artifact_uploads(id,project_id,run_id,path,backend,storage_key,mime_type,
          expected_size,expected_sha256,part_size,part_count,backend_upload_id,created_by_user_id,
          created_by_token_id,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,now()+make_interval(secs=>$15))
        RETURNING ${artifactUploadColumns}`,
        [
          id,
          projectId,
          input.runId ?? null,
          input.path,
          backend,
          storageKey,
          mimeType,
          input.expectedSize,
          input.expectedSha256 ?? null,
          partSize,
          partCount,
          backendUploadId,
          principal.user.id,
          principal.token?.id ?? null,
          UPLOAD_SESSION_LIFETIME_MS / 1000,
        ],
      ))!;
      return publicArtifactUpload(upload);
    } catch (error) {
      await multipart.abortMultipart({ key: storageKey, backendUploadId }).catch(() => undefined);
      throw error;
    }
  }

  /** Lists only the caller's own sessions: another user's or token's parts are not resumable. */
  async listOwn(
    principal: Principal,
    projectId: string,
    filter: { status?: ArtifactUploadStatus },
  ): Promise<ArtifactUpload[]> {
    await requireProject(this.database, principal, { projectId, ...PERMISSION });
    const uploads = await rows<ArtifactUploadRecord>(
      this.database,
      `SELECT ${artifactUploadColumns} FROM artifact_uploads
      WHERE project_id=$1 AND created_by_user_id=$2 AND created_by_token_id IS NOT DISTINCT FROM $3
      AND ($4::text IS NULL OR status=$4) ORDER BY created_at DESC,id DESC`,
      [projectId, principal.user.id, principal.token?.id ?? null, filter.status ?? null],
    );
    return uploads.map(publicArtifactUpload);
  }

  async get(
    principal: Principal,
    projectId: string,
    uploadId: string,
  ): Promise<ArtifactUploadDetail> {
    const upload = await loadOwnUpload(this.database, principal, { projectId, id: uploadId });
    const parts = await listArtifactUploadParts(this.database, upload.id);
    return {
      ...publicArtifactUpload(upload),
      receivedParts: parts.map(({ etag: _etag, ...part }) => part),
    };
  }

  /** Stores one part. Sending the same part number again replaces the earlier bytes. */
  async putPart(
    principal: Principal,
    projectId: string,
    part: {
      uploadId: string;
      partNumber: number;
      /** Content-Length of the request; required because S3 needs it before the body. */
      declaredBytes?: number;
      sha256?: string;
      body: Readable;
    },
  ): Promise<ArtifactUploadPart> {
    const upload = await loadOwnUpload(this.database, principal, {
      projectId,
      id: part.uploadId,
    });
    assertAcceptsParts(upload);
    if (part.partNumber > upload.partCount)
      throw new DomainError(422, `part番号は1〜${upload.partCount}です`, 'invalid_part_number');
    const size = expectedPartBytes(upload, part.partNumber);
    if (part.declaredBytes !== size)
      throw new DomainError(
        422,
        `part ${part.partNumber}のContent-Lengthは${size} bytesにしてください`,
        'part_size_mismatch',
      );
    try {
      const stored = await this.multipartStore(upload.backend).putPart({
        key: upload.storageKey,
        backendUploadId: upload.backendUploadId,
        partNumber: part.partNumber,
        body: part.body,
        size,
        sha256: part.sha256,
      });
      return await transaction(this.database, async (connection) => {
        const current = await first<{ status: ArtifactUploadStatus }>(
          connection,
          'SELECT status FROM artifact_uploads WHERE id=$1 FOR SHARE',
          [upload.id],
        );
        if (current?.status !== 'open') throw uploadNotOpenError();
        return (await first<ArtifactUploadPart>(
          connection,
          `INSERT INTO artifact_upload_parts(upload_id,part_number,size,sha256,etag)
          VALUES($1,$2,$3,$4,$5) ON CONFLICT(upload_id,part_number)
          DO UPDATE SET size=EXCLUDED.size,sha256=EXCLUDED.sha256,etag=EXCLUDED.etag,received_at=now()
          RETURNING part_number,size,sha256,received_at`,
          [upload.id, part.partNumber, stored.size, stored.sha256, stored.etag],
        ))!;
      });
    } catch (error) {
      part.body.destroy();
      // S3 replaces a part before its digest is known, so the recorded part may no longer match
      // the stored bytes. Forgetting it makes the client send this part again.
      await this.database.query(
        `DELETE FROM artifact_upload_parts WHERE upload_id=$1 AND part_number=$2
        AND EXISTS (SELECT 1 FROM artifact_uploads WHERE id=$1 AND status='open')`,
        [upload.id, part.partNumber],
      );
      throw partFailure(error);
    }
  }

  /** Moves a fully received session to verifying; the finalizer registers the Artifact. */
  async complete(
    principal: Principal,
    projectId: string,
    uploadId: string,
  ): Promise<ArtifactUpload> {
    return transaction(this.database, async (connection) => {
      const upload = await loadOwnUpload(connection, principal, {
        projectId,
        id: uploadId,
        lock: true,
      });
      // A retried complete (for example after a lost response) reports the current state.
      if (upload.status === 'verifying' || upload.status === 'completed')
        return publicArtifactUpload(upload);
      assertAcceptsParts(upload);
      if (upload.runId) await assertRunAcceptsArtifacts(connection, projectId, upload.runId);
      const received = await first<{ count: number }>(
        connection,
        'SELECT count(*)::int AS count FROM artifact_upload_parts WHERE upload_id=$1',
        [upload.id],
      );
      const missing = upload.partCount - received!.count;
      if (missing > 0)
        throw new DomainError(
          409,
          `受け取っていないpartが${missing}件あります`,
          'upload_incomplete',
        );
      return publicArtifactUpload(
        (await first<ArtifactUploadRecord>(
          connection,
          `UPDATE artifact_uploads SET status='verifying',updated_at=now() WHERE id=$1
          RETURNING ${artifactUploadColumns}`,
          [upload.id],
        ))!,
      );
    });
  }

  async abort(principal: Principal, projectId: string, uploadId: string): Promise<ArtifactUpload> {
    const aborted = await transaction(this.database, async (connection) => {
      const upload = await loadOwnUpload(connection, principal, {
        projectId,
        id: uploadId,
        lock: true,
      });
      if (upload.status === 'aborted' || upload.status === 'expired') return upload;
      if (upload.status !== 'open') throw uploadNotOpenError();
      return (await first<ArtifactUploadRecord>(
        connection,
        `UPDATE artifact_uploads SET status='aborted',updated_at=now() WHERE id=$1
        RETURNING ${artifactUploadColumns}`,
        [upload.id],
      ))!;
    });
    try {
      await this.stores.multipart(aborted.backend)?.abortMultipart({
        key: aborted.storageKey,
        backendUploadId: aborted.backendUploadId,
      });
    } catch {
      // The sweeper aborts unreferenced backend uploads later; the session is already closed.
      console.error(
        JSON.stringify({ event: 'artifact_upload_abort_failed', uploadId: aborted.id, projectId }),
      );
    }
    return publicArtifactUpload(aborted);
  }

  private multipartStore(backend: ArtifactBackend): ArtifactMultipartStore {
    const multipart = this.stores.multipart(backend);
    if (!multipart)
      throw new DomainError(
        422,
        'このArtifact保存先は再開可能なuploadに対応していません',
        'multipart_unsupported',
      );
    return multipart;
  }
}

/** Only the creating user through the same credential (session or the same API token) may use it. */
async function loadOwnUpload(
  connection: Connection,
  principal: Principal,
  reference: { projectId: string; id: string; lock?: boolean },
): Promise<ArtifactUploadRecord> {
  await requireProject(connection, principal, { projectId: reference.projectId, ...PERMISSION });
  const upload = await findArtifactUpload(connection, reference);
  if (
    upload.createdByUserId !== principal.user.id ||
    upload.createdByTokenId !== (principal.token?.id ?? null)
  )
    throw new DomainError(
      403,
      'このupload sessionは作成したユーザーと認証情報だけが使えます',
      'upload_forbidden',
    );
  return upload;
}

function uploadNotOpenError(): DomainError {
  return new DomainError(409, 'このupload sessionはpartを受け付けていません', 'upload_not_open');
}

function assertAcceptsParts(upload: ArtifactUploadRecord): void {
  if (upload.status !== 'open') throw uploadNotOpenError();
  // The sweeper marks expired sessions periodically; until then the deadline still applies.
  if (new Date(upload.expiresAt) <= new Date())
    throw new DomainError(409, 'upload sessionの期限が切れています', 'upload_expired');
}

async function assertRunAcceptsArtifacts(
  connection: Connection,
  projectId: string,
  runId: string,
): Promise<void> {
  const stage = await runLifecycleStage(connection, { projectId, runId });
  if (!stage) throw new DomainError(404, 'Runが見つかりません', 'not_found');
  if (stage === 'deleted')
    throw new DomainError(409, '削除済みRunにはArtifactを登録できません', 'run_deleted');
}

function partFailure(error: unknown): Error {
  if (error instanceof DomainError) return error;
  if (error instanceof ArtifactPartMismatchError)
    return error.mismatch === 'size'
      ? new DomainError(422, 'partの長さがContent-Lengthと一致しません', 'part_size_mismatch')
      : new DomainError(422, 'partのSHA-256が一致しません', 'part_checksum_mismatch');
  if (error instanceof ArtifactUploadNotFoundError) return uploadNotOpenError();
  return new DomainError(503, 'partの保存に失敗しました', 'artifact_save_failed');
}
