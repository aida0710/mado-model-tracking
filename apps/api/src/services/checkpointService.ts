import type { Artifact, Run, RunCheckpoint, RunCheckpointManifest } from '@mmt/contracts';
import type { Principal } from '../auth/principal.js';
import { first, transaction, type Connection, type Database } from '../db/database.js';
import {
  assertCheckpointRunKind,
  CHECKPOINT_RUN_KINDS,
  parseMlflowCheckpointPath,
  type RunCheckpointCreateInput,
} from '../domain/checkpointValidation.js';
import { DomainError, notFound } from '../domain/errors.js';
import { isTerminalStatus } from '../domain/runTransitions.js';
import {
  checkpointStepExists,
  findCheckpoint,
  findMlflowCheckpointForUpdate,
  findSavedArtifacts,
  hideCheckpointsBeyond,
  insertCheckpoint,
  listRunCheckpoints,
  updateMlflowCheckpointFiles,
} from '../repositories/checkpointRepository.js';
import { findRun } from '../repositories/registryRepository.js';
import { requireProject } from './accessService.js';
import { notifyListener } from './eventListeners.js';
import { assertRunRecordsWritable } from './runService.js';

type RunReference = { projectId: string; runId: string };

/**
 * Told about a checkpoint saved through POST /runs/:r/checkpoints (hooks with trigger
 * checkpoint_saved). MLflow checkpoints are not announced: their files arrive one by one and
 * nothing tells when the last one has arrived.
 */
export interface CheckpointListener {
  readonly name: string;
  onCheckpointSaved(
    connection: Connection,
    saved: { checkpoint: RunCheckpoint; run: Run },
  ): Promise<void>;
}

export class CheckpointService {
  constructor(
    private readonly database: Database,
    private readonly retention: { keepCount: number },
    // Kept by reference: app.ts adds the hooks once they are built.
    private readonly listeners: readonly CheckpointListener[] = [],
  ) {}

  async list(
    principal: Principal,
    query: RunReference & { includeHidden: boolean },
  ): Promise<RunCheckpoint[]> {
    await requireProject(this.database, principal, {
      projectId: query.projectId,
      role: 'viewer',
      scope: 'read',
    });
    await findRun(this.database, { projectId: query.projectId, id: query.runId });
    return listRunCheckpoints(this.database, query);
  }

  async create(
    principal: Principal,
    reference: RunReference,
    input: RunCheckpointCreateInput,
  ): Promise<RunCheckpoint> {
    return transaction(this.database, async (connection) => {
      await requireCheckpointWriter(connection, principal, reference);
      const run = await findRun(connection, {
        projectId: reference.projectId,
        id: reference.runId,
        lock: true,
      });
      assertCheckpointRunKind(run.kind);
      await assertRunRecordsWritable(connection, run);
      const [artifact] = await findSavedArtifacts(connection, {
        projectId: reference.projectId,
        ids: [input.artifactId],
      });
      if (!artifact) notFound('Artifact');
      if (artifact.runId !== run.id)
        throw new DomainError(
          422,
          'checkpointには同じRunに保存したArtifactを指定してください',
          'checkpoint_artifact_run',
        );
      if (await checkpointStepExists(connection, { runId: run.id, step: input.step }))
        throw new DomainError(409, 'このstepのcheckpointは登録済みです', 'checkpoint_exists');
      const id = await insertCheckpoint(connection, {
        projectId: reference.projectId,
        runId: run.id,
        step: input.step,
        source: 'native',
        artifactIds: [artifact.id],
        manifest: {
          files: input.manifest.files,
          includesOptimizer: input.manifest.includesOptimizer,
          framework: input.manifest.framework ?? null,
        },
        metadata: input.metadata,
      });
      await hideCheckpointsBeyond(connection, {
        runId: run.id,
        keepCount: this.retention.keepCount,
      });
      const checkpoint = await findCheckpoint(connection, { projectId: reference.projectId, id });
      for (const listener of this.listeners)
        await notifyListener(connection, {
          listener: listener.name,
          subjectId: checkpoint.id,
          notify: () => listener.onCheckpointSaved(connection, { checkpoint, run }),
        });
      return checkpoint;
    });
  }

  /**
   * Called from the MLflow artifact save hook, inside the transaction that registers the file.
   * The first file of checkpoints/step-<N>/ creates the checkpoint, later ones extend its
   * manifest. Once the Run has ended the checkpoint is final and further files are refused.
   */
  async recordMlflowArtifact(
    connection: Connection,
    saved: { projectId: string; runId: string; artifact: Artifact; artifactPath: string },
  ): Promise<void> {
    const location = parseMlflowCheckpointPath(saved.artifactPath);
    if (!location) return;
    const run = await findRun(connection, { projectId: saved.projectId, id: saved.runId });
    // Another kind of Run may use the same directory name for unrelated files.
    if (!CHECKPOINT_RUN_KINDS.includes(run.kind)) return;
    const file = {
      path: location.relativePath,
      sha256: saved.artifact.sha256,
      size: saved.artifact.size,
    };
    const existing = await findMlflowCheckpointForUpdate(connection, {
      projectId: saved.projectId,
      runId: run.id,
      step: location.step,
    });
    if (existing?.final || (isTerminalStatus(run.status) && !existing))
      throw new DomainError(
        409,
        '終了したRunのcheckpointにはファイルを追加できません',
        'checkpoint_finalized',
      );
    if (existing) {
      await this.replaceMlflowCheckpointFile(connection, {
        projectId: saved.projectId,
        checkpoint: existing,
        artifactId: saved.artifact.id,
        file,
      });
      return;
    }
    // A native checkpoint already owns this step; the MLflow files stay ordinary Artifacts.
    if (await checkpointStepExists(connection, { runId: run.id, step: location.step })) return;
    await insertCheckpoint(connection, {
      projectId: saved.projectId,
      runId: run.id,
      step: location.step,
      source: 'mlflow',
      artifactIds: [saved.artifact.id],
      manifest: { files: [file], includesOptimizer: false, framework: null },
      metadata: {},
    });
    await hideCheckpointsBeyond(connection, {
      runId: run.id,
      keepCount: this.retention.keepCount,
    });
  }

  // Re-logging a path replaces that file, as MLflow overwrites the artifact at the same path.
  private async replaceMlflowCheckpointFile(
    connection: Connection,
    update: {
      projectId: string;
      checkpoint: { id: string; artifactIds: string[]; manifest: RunCheckpointManifest };
      artifactId: string;
      file: RunCheckpointManifest['files'][number];
    },
  ): Promise<void> {
    const { checkpoint, file } = update;
    const previous = await findSavedArtifacts(connection, {
      projectId: update.projectId,
      ids: checkpoint.artifactIds,
    });
    const replacedIds = new Set(
      previous
        .filter((artifact) => parseMlflowCheckpointPath(artifact.path)?.relativePath === file.path)
        .map((artifact) => artifact.id),
    );
    await updateMlflowCheckpointFiles(connection, {
      id: checkpoint.id,
      artifactIds: [...checkpoint.artifactIds.filter((id) => !replacedIds.has(id)), update.artifactId],
      manifest: {
        ...checkpoint.manifest,
        files: [...checkpoint.manifest.files.filter((entry) => entry.path !== file.path), file],
      },
    });
  }
}

/**
 * Users need runs:write as an editor. Code inside a Job reaches here with its Job token, which
 * the Job token guard already limits to its own Run. A worker token may register for a Run whose
 * Job it currently holds.
 */
async function requireCheckpointWriter(
  connection: Connection,
  principal: Principal,
  reference: RunReference,
): Promise<void> {
  const token = principal.token;
  if (
    principal.method === 'token' &&
    token?.projectId === reference.projectId &&
    token.scopes.includes('worker:execute') &&
    !token.scopes.includes('runs:write')
  ) {
    await requireProject(connection, principal, {
      projectId: reference.projectId,
      role: 'editor',
      scope: 'worker:execute',
    });
    const heldJob = await first(
      connection,
      `SELECT id FROM jobs WHERE project_id=$1 AND run_id=$2 AND worker_token_id=$3
      AND status IN ('claimed','running')`,
      [reference.projectId, reference.runId, token.id],
    );
    if (!heldJob)
      throw new DomainError(
        403,
        'worker tokenは実行中のJobのRunにだけcheckpointを登録できます',
        'checkpoint_forbidden',
      );
    return;
  }
  await requireProject(connection, principal, {
    projectId: reference.projectId,
    role: 'editor',
    scope: 'runs:write',
  });
}
