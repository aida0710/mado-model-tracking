import { transaction, type Database } from '../../db/database.js';
import { DomainError, notFound } from '../../domain/errors.js';
import type { ArtifactService } from '../../services/artifactService.js';
import type { CheckpointService } from '../../services/checkpointService.js';
import { requireArtifactOwner, requireArtifactProject } from './artifactAccess.js';
import { listArtifactDirectory } from './artifactListing.js';
import { nativeArtifactPath, validateArtifactOwner, validateArtifactPath } from './artifactPath.js';
import {
  findArtifactPath,
  listArtifactPaths,
  replaceArtifactPath,
  requireNonconflictingArtifactPath,
} from './artifactPathRepository.js';
import type { ArtifactAccess, ArtifactFile, ArtifactUpload } from './artifactTypes.js';
import { MlmodelCapture, saveLoggedModelMlmodel } from './mlmodelCapture.js';
import { modelVersionArtifactManifest } from './modelVersionArtifactRepository.js';

export class ArtifactTransferService {
  constructor(
    private readonly database: Database,
    private readonly artifacts: ArtifactService,
    // Registers files under checkpoints/step-<N>/ as Run checkpoints; absent in tests that skip it.
    private readonly checkpoints?: CheckpointService,
  ) {}

  async list(access: ArtifactAccess & { path: string }): Promise<ArtifactFile[]> {
    access = { ...access, owner: validateArtifactOwner(access.owner) };
    const path = validateArtifactPath(access.path, { directory: true });
    await requireArtifactProject(this.database, access);
    if (access.owner.kind === 'model-version')
      return listArtifactDirectory(await modelVersionArtifactManifest(this.database, access), path);
    await requireArtifactOwner(this.database, access);
    return listArtifactDirectory(await listArtifactPaths(this.database, access), path);
  }

  async upload(upload: ArtifactUpload): Promise<void> {
    let capture: MlmodelCapture | null = null;
    // The incoming stream can fail while authorization awaits the DB. Pipeline still observes errored streams.
    upload.body.on('error', () => undefined);
    try {
      upload = { ...upload, owner: validateArtifactOwner(upload.owner) };
      if (upload.owner.kind === 'model-version')
        throw new DomainError(409, '登録モデル版のArtifactは変更できません', 'conflict');
      validateArtifactPath(upload.path);
      const path = nativeArtifactPath(upload);
      const authorized = await transaction(this.database, async (connection) => {
        const identity = await requireArtifactProject(connection, upload, {
          write: true,
          lock: true,
        });
        const owner = await requireArtifactOwner(connection, upload, { write: true, lock: true });
        await requireNonconflictingArtifactPath(connection, upload);
        return { identity, runId: owner.runId };
      });
      // A destroyed source cannot emit a second error/end to a newly attached capture stream.
      if (upload.body.errored || (upload.body.destroyed && !upload.body.readableEnded))
        throw new DomainError(503, 'Artifactの入力streamが切断されました', 'artifact_save_failed');
      capture =
        upload.owner.kind === 'model' && upload.path === 'MLmodel' ? new MlmodelCapture() : null;
      if (capture) {
        const metadataStream = capture;
        // Match the incoming stream's early-error handling before ArtifactService starts its pipeline.
        metadataStream.on('error', () => undefined);
        upload.body.on('error', (error) => metadataStream.destroy(error)).pipe(metadataStream);
      }
      await this.artifacts.upload(authorized.identity, upload.projectId, {
        runId: authorized.runId ?? undefined,
        path,
        mimeType: upload.mimeType,
        body: capture ?? upload.body,
        onStored: async (connection, artifact) => {
          await requireArtifactProject(connection, upload, { write: true, lock: true });
          const owner = await requireArtifactOwner(connection, upload, { write: true, lock: true });
          if (owner.runId !== authorized.runId)
            throw new DomainError(409, 'Artifactのsource Runが変更されました', 'conflict');
          await requireNonconflictingArtifactPath(connection, upload);
          await replaceArtifactPath(connection, { ...upload, artifact, runId: authorized.runId });
          if (upload.owner.kind === 'run')
            await this.checkpoints?.recordMlflowArtifact(connection, {
              projectId: upload.projectId,
              runId: upload.owner.id,
              artifact,
              artifactPath: upload.path,
            });
          if (!capture) return;
          await saveLoggedModelMlmodel(connection, {
            projectId: upload.projectId,
            id: upload.owner.id,
            metadata: capture.metadata(),
          });
        },
      });
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new DomainError(503, 'Artifactの保存参照を更新できません', 'artifact_save_failed');
    } finally {
      // Destroying a failed stream also cancels the incoming request instead of reading its remainder.
      capture?.destroy();
      upload.body.destroy();
    }
  }

  async content(access: ArtifactAccess & { path: string; range?: string }) {
    access = { ...access, owner: validateArtifactOwner(access.owner) };
    validateArtifactPath(access.path);
    const identity = await requireArtifactProject(this.database, access);
    if (access.owner.kind === 'model-version') {
      const manifest = await modelVersionArtifactManifest(this.database, access);
      const artifact = manifest.find((entry) => entry.path === access.path);
      if (!artifact) notFound('Artifact');
      return this.artifacts.content(identity, access.projectId, {
        artifactId: artifact.artifactId,
        range: access.range,
      });
    }
    await requireArtifactOwner(this.database, access);
    const artifactId = await findArtifactPath(this.database, access);
    return this.artifacts.content(identity, access.projectId, { artifactId, range: access.range });
  }
}
