import { randomUUID } from 'node:crypto';
import { pipeline, type Readable } from 'node:stream';
import type { Artifact, ArtifactBackend } from '@mmt/contracts';
import {
  ArtifactNotFoundError,
  ArtifactRangeError,
  type ArtifactContent,
  type ArtifactStores,
} from '@mmt/platform';
import type { Principal } from '../auth/principal.js';
import { first, rows, transaction, type Connection, type Database } from '../db/database.js';
import { resolveArtifactMimeType } from '../domain/artifactMimeType.js';
import { DomainError, notFound } from '../domain/errors.js';
import { isRelativeFilePath } from '../domain/validation.js';
import { findRun } from '../repositories/registryRepository.js';
import { requireProject } from './accessService.js';
import {
  ArtifactSizeLimit,
  artifactTooLargeError,
  assertDeclaredArtifactSize,
} from './artifactSizeLimit.js';

export interface ArtifactLimits {
  maxBytes: number;
}

// Test doubles that build the service directly opt out of the limit; the app passes the configured one.
const UNLIMITED: ArtifactLimits = { maxBytes: Number.POSITIVE_INFINITY };

export class ArtifactService {
  constructor(
    private readonly database: Database,
    readonly stores: ArtifactStores,
    private readonly limits: ArtifactLimits = UNLIMITED,
  ) {}

  async listProject(
    principal: Principal,
    projectId: string,
    filter: { limit: number; query?: string },
  ): Promise<Artifact[]> {
    await requireProject(this.database, principal, { projectId, role: 'viewer', scope: 'read' });
    return rows(
      this.database,
      `SELECT * FROM artifacts WHERE project_id=$1
       AND ($3::text IS NULL OR path ILIKE '%' || $3 || '%')
       ORDER BY created_at DESC,id DESC LIMIT $2`,
      [projectId, filter.limit, filter.query ?? null],
    );
  }

  async getMetadata(
    principal: Principal,
    projectId: string,
    artifactId: string,
  ): Promise<Artifact> {
    await requireProject(this.database, principal, { projectId, role: 'viewer', scope: 'read' });
    const artifact = await first<Artifact>(
      this.database,
      'SELECT * FROM artifacts WHERE id=$1 AND project_id=$2',
      [artifactId, projectId],
    );
    if (!artifact) notFound('Artifact');
    return artifact;
  }

  async list(principal: Principal, projectId: string, runId: string): Promise<Artifact[]> {
    await requireProject(this.database, principal, { projectId, role: 'viewer', scope: 'read' });
    await findRun(this.database, { projectId, id: runId });
    return rows(
      this.database,
      'SELECT * FROM artifacts WHERE project_id=$1 AND run_id=$2 ORDER BY created_at DESC',
      [projectId, runId],
    );
  }

  async upload(
    principal: Principal,
    projectId: string,
    upload: {
      runId?: string;
      path: string;
      mimeType?: string;
      /** Content-Length from the request, when the client declared one. */
      declaredBytes?: number;
      body: Readable;
      onStored?: (connection: Connection, artifact: Artifact) => Promise<void>;
    },
  ): Promise<Artifact> {
    await requireProject(this.database, principal, {
      projectId,
      role: 'editor',
      scope: 'artifacts:write',
    });
    if (!isRelativeFilePath(upload.path) || upload.path.length > 1024)
      throw new DomainError(422, 'Artifactには安全な相対パスが必要です', 'invalid_artifact_path');
    if (upload.runId) await findRun(this.database, { projectId, id: upload.runId });
    assertDeclaredArtifactSize(upload.declaredBytes, this.limits.maxBytes);
    const project = (await first<{ artifactBackend: ArtifactBackend }>(
      this.database,
      'SELECT artifact_backend FROM projects WHERE id=$1',
      [projectId],
    ))!;
    if (!this.stores.backends().includes(project.artifactBackend))
      throw new DomainError(503, 'Artifact保存先が設定されていません', 'backend_unavailable');
    const id = randomUUID();
    const key = `${projectId}/${id}/content`;
    const reference = { backend: project.artifactBackend, key };
    const mimeType = resolveArtifactMimeType({
      path: upload.path,
      declaredMimeType: upload.mimeType,
    });
    const sizeLimit = new ArtifactSizeLimit(this.limits.maxBytes);
    // pipeline() destroys the request stream when the limit trips, so the rest is not read.
    const limitedBody = pipeline(upload.body, sizeLimit, () => undefined);
    try {
      const stored = await this.stores.put({ ...reference, body: limitedBody, mimeType });
      return await transaction(this.database, async (connection) => {
        // Permission and run references are checked again after a potentially long streaming write.
        await requireProject(connection, principal, {
          projectId,
          role: 'editor',
          scope: 'artifacts:write',
        });
        if (upload.runId) await findRun(connection, { projectId, id: upload.runId });
        const artifact = (await first<Artifact>(
          connection,
          `INSERT INTO artifacts(id,project_id,run_id,path,backend,storage_key,mime_type,size,sha256)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
          [
            id,
            projectId,
            upload.runId ?? null,
            upload.path,
            reference.backend,
            key,
            mimeType,
            stored.size,
            stored.sha256,
          ],
        ))!;
        // Commit the compatibility index with its Artifact so failed mappings leave no visible file.
        await upload.onStored?.(connection, artifact);
        return artifact;
      });
    } catch (error) {
      try {
        await this.stores.remove(reference);
      } catch {
        // No storage locations or credentials are logged; the immutable id identifies a cleanup task.
        console.error(
          JSON.stringify({ event: 'artifact_cleanup_failed', artifactId: id, projectId }),
        );
      }
      // Stores may report the aborted pipeline as their own error instead of the limit's error.
      if (sizeLimit.isExceeded) throw artifactTooLargeError(this.limits.maxBytes);
      if (error instanceof DomainError) throw error;
      throw new DomainError(503, 'Artifactの保存に失敗しました', 'artifact_save_failed');
    }
  }

  async content(
    principal: Principal,
    projectId: string,
    download: { artifactId: string; range?: string },
  ): Promise<{ artifact: Artifact; content: ArtifactContent }> {
    const artifact = await this.getMetadata(principal, projectId, download.artifactId);
    return { artifact, content: await this.readContent(artifact, download.range) };
  }

  /** Reads an Artifact already authorized through getMetadata; callers must not skip that check. */
  async readContent(artifact: Artifact, range?: string): Promise<ArtifactContent> {
    try {
      return await this.stores.read({
        backend: artifact.backend,
        key: artifact.storageKey,
        range,
      });
    } catch (error) {
      if (error instanceof ArtifactRangeError) throw error;
      if (error instanceof ArtifactNotFoundError)
        throw new DomainError(
          404,
          'Artifactの実ファイルが見つかりません',
          'artifact_content_not_found',
        );
      throw new DomainError(503, 'Artifactを読み込めません', 'artifact_read_failed');
    }
  }
}
