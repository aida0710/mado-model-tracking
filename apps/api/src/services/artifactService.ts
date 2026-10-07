import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type { Artifact, ArtifactBackend } from '@mmt/contracts';
import {
  ArtifactNotFoundError,
  ArtifactRangeError,
  type ArtifactContent,
  type ArtifactStores,
} from '@mmt/platform';
import type { Principal } from '../auth/principal.js';
import { first, rows, transaction, type Database } from '../db/database.js';
import { DomainError, notFound } from '../domain/errors.js';
import { isRelativeFilePath } from '../domain/validation.js';
import { findRun } from '../repositories/registryRepository.js';
import { requireProject } from './accessService.js';

export class ArtifactService {
  constructor(
    private readonly database: Database,
    readonly stores: ArtifactStores,
  ) {}

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
    upload: { runId?: string; path: string; mimeType: string; body: Readable },
  ): Promise<Artifact> {
    await requireProject(this.database, principal, {
      projectId,
      role: 'editor',
      scope: 'artifacts:write',
    });
    if (!isRelativeFilePath(upload.path) || upload.path.length > 1024)
      throw new DomainError(422, 'Artifactには安全な相対パスが必要です', 'invalid_artifact_path');
    if (upload.runId) await findRun(this.database, { projectId, id: upload.runId });
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
    const mimeType = /^[\w!#$&^.+-]+\/[\w!#$&^.+-]+(?:;[^\r\n]*)?$/.test(upload.mimeType)
      ? upload.mimeType
      : 'application/octet-stream';
    try {
      const stored = await this.stores.put({ ...reference, body: upload.body, mimeType });
      return await transaction(this.database, async (connection) => {
        // Permission and run references are checked again after a potentially long streaming write.
        await requireProject(connection, principal, {
          projectId,
          role: 'editor',
          scope: 'artifacts:write',
        });
        if (upload.runId) await findRun(connection, { projectId, id: upload.runId });
        return (await first<Artifact>(
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
      if (error instanceof DomainError) throw error;
      throw new DomainError(503, 'Artifactの保存に失敗しました', 'artifact_save_failed');
    }
  }

  async content(
    principal: Principal,
    projectId: string,
    download: { artifactId: string; range?: string },
  ): Promise<{ artifact: Artifact; content: ArtifactContent }> {
    await requireProject(this.database, principal, { projectId, role: 'viewer', scope: 'read' });
    const artifact = await first<Artifact>(
      this.database,
      'SELECT * FROM artifacts WHERE id=$1 AND project_id=$2',
      [download.artifactId, projectId],
    );
    if (!artifact) notFound('Artifact');
    try {
      return {
        artifact,
        content: await this.stores.read({
          backend: artifact.backend,
          key: artifact.storageKey,
          range: download.range,
        }),
      };
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
