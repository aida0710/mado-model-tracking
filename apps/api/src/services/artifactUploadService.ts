import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
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
import { DomainError, notFound } from '../domain/errors.js';
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
// 256 bits: the token alone authorizes part requests for the session's lifetime.
const PART_TOKEN_BYTES = 32;

/** Native sessions belong to the artifact-uploads API; MLflow sessions to the mpu endpoints. */
type UploadProtocol = 'native' | 'mlflow';

/** Columns written when a session is opened; MLflow sessions leave the sizes unknown. */
interface SessionFields {
  path: string;
  runId: string | null;
  mimeType: string;
  expectedSize: number | null;
  expectedSha256: string | null;
  partSize: number | null;
  partCount: number;
  owner: { kind: 'run' | 'model'; id: string } | null;
  partTokenHash: string | null;
}

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
    const upload = await this.openSession(principal, projectId, {
      path: input.path,
      runId: input.runId ?? null,
      mimeType: resolveArtifactMimeType({ path: input.path, declaredMimeType: input.mimeType }),
      expectedSize: input.expectedSize,
      expectedSha256: input.expectedSha256 ?? null,
      partSize,
      partCount,
      owner: null,
      partTokenHash: null,
    });
    return publicArtifactUpload(upload);
  }

  /**
   * Opens an MLflow multipart session for an Artifact path owner. The caller has authorized the
   * owner; the returned part token is shown once and authorizes this session's part requests.
   */
  async createOwned(
    principal: Principal,
    projectId: string,
    input: {
      path: string;
      runId: string | null;
      partCount: number;
      owner: { kind: 'run' | 'model'; id: string };
    },
  ): Promise<{ upload: ArtifactUploadRecord; partToken: string }> {
    await requireProject(this.database, principal, { projectId, ...PERMISSION });
    assertArtifactPath(input.path);
    if (input.partCount < 1 || input.partCount > MULTIPART_MAX_PART_COUNT)
      throw new DomainError(
        422,
        `part数は1〜${MULTIPART_MAX_PART_COUNT}にしてください`,
        'too_many_parts',
      );
    if (input.runId) await assertRunAcceptsArtifacts(this.database, projectId, input.runId);
    const partToken = randomBytes(PART_TOKEN_BYTES).toString('base64url');
    const upload = await this.openSession(principal, projectId, {
      path: input.path,
      runId: input.runId,
      mimeType: resolveArtifactMimeType({ path: input.path }),
      expectedSize: null,
      expectedSha256: null,
      partSize: null,
      partCount: input.partCount,
      owner: input.owner,
      partTokenHash: hashPartToken(partToken),
    });
    return { upload, partToken };
  }

  private async openSession(
    principal: Principal,
    projectId: string,
    fields: SessionFields,
  ): Promise<ArtifactUploadRecord> {
    const backend = await projectArtifactBackend(this.database, projectId, this.stores);
    const multipart = this.multipartStore(backend);
    const id = randomUUID();
    const credential = uploadCredential(principal);
    // The Artifact registered on completion reuses this id, so the key matches single uploads.
    const storageKey = `${projectId}/${id}/content`;
    const { backendUploadId } = await multipart.createMultipart({
      key: storageKey,
      mimeType: fields.mimeType,
    });
    try {
      return (await first<ArtifactUploadRecord>(
        this.database,
        `INSERT INTO artifact_uploads(id,project_id,run_id,path,backend,storage_key,mime_type,
          expected_size,expected_sha256,part_size,part_count,backend_upload_id,created_by_user_id,
          created_by_token_id,created_by_job_token_id,owner_kind,owner_id,part_token_hash,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,
          now()+make_interval(secs=>$19))
        RETURNING ${artifactUploadColumns}`,
        [
          id,
          projectId,
          fields.runId,
          fields.path,
          backend,
          storageKey,
          fields.mimeType,
          fields.expectedSize,
          fields.expectedSha256,
          fields.partSize,
          fields.partCount,
          backendUploadId,
          principal.user.id,
          credential.apiTokenId,
          credential.jobTokenId,
          fields.owner?.kind ?? null,
          fields.owner?.id ?? null,
          fields.partTokenHash,
          UPLOAD_SESSION_LIFETIME_MS / 1000,
        ],
      ))!;
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
    const credential = uploadCredential(principal);
    const uploads = await rows<ArtifactUploadRecord>(
      this.database,
      `SELECT ${artifactUploadColumns} FROM artifact_uploads
      WHERE project_id=$1 AND created_by_user_id=$2 AND created_by_token_id IS NOT DISTINCT FROM $3
      AND created_by_job_token_id IS NOT DISTINCT FROM $4 AND owner_kind IS NULL
      AND ($5::text IS NULL OR status=$5) ORDER BY created_at DESC,id DESC`,
      [
        projectId,
        principal.user.id,
        credential.apiTokenId,
        credential.jobTokenId,
        filter.status ?? null,
      ],
    );
    return uploads.map(publicArtifactUpload);
  }

  async get(
    principal: Principal,
    projectId: string,
    uploadId: string,
  ): Promise<ArtifactUploadDetail> {
    const upload = await loadOwnUpload(this.database, principal, {
      projectId,
      id: uploadId,
      protocol: 'native',
    });
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
      protocol: 'native',
    });
    assertAcceptsParts(upload);
    assertPartNumber(upload, part.partNumber);
    const size = expectedPartBytes(upload, part.partNumber);
    if (part.declaredBytes !== size)
      throw new DomainError(
        422,
        `part ${part.partNumber}のContent-Lengthは${size} bytesにしてください`,
        'part_size_mismatch',
      );
    return this.storePart(upload, { ...part, size });
  }

  /**
   * Stores one part of an MLflow session, authorized by its part token alone. Part sizes are not
   * known in advance, so only the backend limits apply: non-final parts need the S3 minimum.
   */
  async putPartWithToken(
    projectId: string,
    part: {
      uploadId: string;
      partNumber: number;
      partToken: string | undefined;
      declaredBytes?: number;
      body: Readable;
    },
  ): Promise<ArtifactUploadPart> {
    const upload = await findTokenUpload(this.database, {
      projectId,
      id: part.uploadId,
      partToken: part.partToken,
    });
    assertAcceptsParts(upload);
    assertPartNumber(upload, part.partNumber);
    const size = part.declaredBytes;
    if (size === undefined)
      throw new DomainError(422, 'partにはContent-Lengthが必要です', 'part_size_mismatch');
    if (size > MULTIPART_MAX_PART_BYTES)
      throw new DomainError(
        422,
        `partは${MULTIPART_MAX_PART_BYTES} bytes以下にしてください`,
        'invalid_part_size',
      );
    const isFinalPart = part.partNumber === upload.partCount;
    if (!isFinalPart && size < MULTIPART_MIN_PART_BYTES)
      throw new DomainError(
        422,
        `最後以外のpartは${MULTIPART_MIN_PART_BYTES} bytes以上にしてください`,
        'part_too_small',
      );
    // Every non-final part has the client's chunk size, so this is a lower bound of the total.
    if (!isFinalPart && size * (upload.partCount - 1) > this.limits.maxBytes)
      throw artifactTooLargeError(this.limits.maxBytes);
    return this.storePart(upload, { ...part, size });
  }

  private async storePart(
    upload: ArtifactUploadRecord,
    part: { partNumber: number; size: number; sha256?: string; body: Readable },
  ): Promise<ArtifactUploadPart> {
    const { size } = part;
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
        protocol: 'native',
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

  /**
   * Moves a fully received MLflow session to verifying and records its sizes, which are known only
   * now. `authorize` runs in the same transaction so the Artifact owner is checked under lock.
   */
  async completeOwned(
    principal: Principal,
    projectId: string,
    input: {
      uploadId: string;
      /** The parts the client reports; a reported SHA-256 must match the stored part. */
      parts: { partNumber: number; sha256: string | null }[];
      authorize: (connection: Connection, upload: ArtifactUploadRecord) => Promise<void>;
    },
  ): Promise<ArtifactUploadRecord> {
    return transaction(this.database, async (connection) => {
      const upload = await loadOwnUpload(connection, principal, {
        projectId,
        id: input.uploadId,
        lock: true,
        protocol: 'mlflow',
      });
      // A retried complete (for example after a lost response) reports the current state.
      if (upload.status === 'verifying' || upload.status === 'completed') return upload;
      assertAcceptsParts(upload);
      if (upload.runId) await assertRunAcceptsArtifacts(connection, projectId, upload.runId);
      await input.authorize(connection, upload);
      const received = await listArtifactUploadParts(connection, upload.id);
      const missing = upload.partCount - received.length;
      if (missing > 0)
        throw new DomainError(
          409,
          `受け取っていないpartが${missing}件あります`,
          'upload_incomplete',
        );
      assertReportedParts(received, input.parts);
      const totalBytes = received.reduce((total, part) => total + part.size, 0);
      if (totalBytes > this.limits.maxBytes) throw artifactTooLargeError(this.limits.maxBytes);
      return (await first<ArtifactUploadRecord>(
        connection,
        `UPDATE artifact_uploads SET status='verifying',expected_size=$2,part_size=$3,updated_at=now()
        WHERE id=$1 RETURNING ${artifactUploadColumns}`,
        [upload.id, totalBytes, received[0]!.size],
      ))!;
    });
  }

  async abort(principal: Principal, projectId: string, uploadId: string): Promise<ArtifactUpload> {
    return this.abortSession(
      (connection) =>
        loadOwnUpload(connection, principal, {
          projectId,
          id: uploadId,
          lock: true,
          protocol: 'native',
        }),
      projectId,
    );
  }

  /** Aborts an MLflow session; only its creator through the same credential may abort it. */
  async abortOwned(
    principal: Principal,
    projectId: string,
    uploadId: string,
  ): Promise<ArtifactUpload> {
    return this.abortSession(
      (connection) =>
        loadOwnUpload(connection, principal, {
          projectId,
          id: uploadId,
          lock: true,
          protocol: 'mlflow',
        }),
      projectId,
    );
  }

  private async abortSession(
    loadLocked: (connection: Connection) => Promise<ArtifactUploadRecord>,
    projectId: string,
  ): Promise<ArtifactUpload> {
    const aborted = await transaction(this.database, async (connection) => {
      const upload = await loadLocked(connection);
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

/** The token a session belongs to; a Job token's id refers to job_tokens, not api_tokens. */
function uploadCredential(principal: Principal): {
  apiTokenId: string | null;
  jobTokenId: string | null;
} {
  const token = principal.token;
  if (!token) return { apiTokenId: null, jobTokenId: null };
  return token.job
    ? { apiTokenId: null, jobTokenId: token.id }
    : { apiTokenId: token.id, jobTokenId: null };
}

/** Only the creating user through the same credential (session, API token or Job token) may use it. */
async function loadOwnUpload(
  connection: Connection,
  principal: Principal,
  reference: { projectId: string; id: string; lock?: boolean; protocol: UploadProtocol },
): Promise<ArtifactUploadRecord> {
  await requireProject(connection, principal, { projectId: reference.projectId, ...PERMISSION });
  const upload = await findArtifactUpload(connection, reference);
  // Each session is completed through the API that opened it; the other API does not see it.
  if ((upload.ownerKind !== null) !== (reference.protocol === 'mlflow')) notFound('Upload session');
  const credential = uploadCredential(principal);
  if (
    upload.createdByUserId !== principal.user.id ||
    upload.createdByTokenId !== credential.apiTokenId ||
    upload.createdByJobTokenId !== credential.jobTokenId
  )
    throw new DomainError(
      403,
      'このupload sessionは作成したユーザーと認証情報だけが使えます',
      'upload_forbidden',
    );
  return upload;
}

function hashPartToken(partToken: string): string {
  return createHash('sha256').update(partToken).digest('hex');
}

/** An MLflow session whose part token matches; the token is the only credential of part requests. */
async function findTokenUpload(
  connection: Connection,
  reference: { projectId: string; id: string; partToken: string | undefined },
): Promise<ArtifactUploadRecord> {
  if (!reference.partToken)
    throw new DomainError(401, 'upload tokenが必要です', 'upload_token_required');
  const upload = await first<ArtifactUploadRecord & { partTokenHash: string | null }>(
    connection,
    `SELECT ${artifactUploadColumns},part_token_hash FROM artifact_uploads
    WHERE project_id=$1 AND id=$2`,
    [reference.projectId, reference.id],
  );
  if (!upload) notFound('Upload session');
  const presented = Buffer.from(hashPartToken(reference.partToken), 'hex');
  const stored = Buffer.from(upload.partTokenHash ?? '', 'hex');
  if (stored.length !== presented.length || !timingSafeEqual(stored, presented))
    throw new DomainError(
      403,
      'このupload sessionのupload tokenではありません',
      'upload_forbidden',
    );
  return upload;
}

function assertPartNumber(upload: ArtifactUploadRecord, partNumber: number): void {
  if (partNumber > upload.partCount)
    throw new DomainError(422, `part番号は1〜${upload.partCount}です`, 'invalid_part_number');
}

/** A reported part whose digest differs was replaced after the client sent it. */
function assertReportedParts(
  received: { partNumber: number; sha256: string }[],
  reported: { partNumber: number; sha256: string | null }[],
): void {
  const stored = new Map(received.map((part) => [part.partNumber, part.sha256]));
  const reportedNumbers = new Set(reported.map((part) => part.partNumber));
  if (reportedNumbers.size !== reported.length || reportedNumbers.size !== stored.size)
    throw new DomainError(422, 'partsは全partを1件ずつ指定してください', 'invalid_parts');
  for (const part of reported) {
    const sha256 = stored.get(part.partNumber);
    if (sha256 === undefined)
      throw new DomainError(422, `part ${part.partNumber}は受け取っていません`, 'invalid_parts');
    if (part.sha256 !== null && part.sha256 !== sha256)
      throw new DomainError(
        409,
        `part ${part.partNumber}は送信後に置き換えられています`,
        'part_replaced',
      );
  }
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
