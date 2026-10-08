import type {
  Run,
  RunCheckpoint,
  RunResumeCheckpointRecord,
  WorkerResumeCheckpoint,
} from '@mmt/contracts';
import type { Connection } from '../db/database.js';
import { assertResumableFrom, type JobRetryInput } from '../domain/checkpointValidation.js';
import { DomainError } from '../domain/errors.js';
import {
  findCheckpoint,
  findLatestCheckpointId,
  findRunCodeLineage,
  pinRunResumeCheckpoint,
} from '../repositories/checkpointRepository.js';
import { findRun } from '../repositories/registryRepository.js';

// Continuing a new Run from a saved checkpoint. Callers run these inside the transaction that
// creates the Run, after their own authorization and before the Run's Job is inserted.

/**
 * The checkpoint a Job retry continues from: the requested one, or the largest step of the
 * retried Run. A retried Run that saved none continues from the checkpoint it resumed from.
 */
export async function selectRetryCheckpoint(
  connection: Connection,
  retry: { projectId: string; previousRun: Run; request: JobRetryInput },
): Promise<string | null> {
  const { previousRun, request } = retry;
  if (request.checkpointId) return request.checkpointId;
  if (!request.resumeFromLatestCheckpoint) return null;
  const latest =
    (await findLatestCheckpointId(connection, {
      projectId: retry.projectId,
      runId: previousRun.id,
    })) ?? previousRun.resumeCheckpointId;
  if (!latest)
    throw new DomainError(422, '再開できるcheckpointがありません', 'checkpoint_not_found');
  return latest;
}

/**
 * Pins a Run created in this transaction (before its Job) to a checkpoint: resume_checkpoint_id,
 * environment.resume and, unless the caller chose one, parentRunId = the checkpoint's Run.
 */
export async function pinResumeCheckpoint(
  connection: Connection,
  pin: { run: Run; checkpointId: string },
): Promise<Run> {
  const { run } = pin;
  const checkpoint = await findCheckpoint(connection, {
    projectId: run.projectId,
    id: pin.checkpointId,
  });
  assertResumableFrom(
    await findRunCodeLineage(connection, { projectId: run.projectId, runId: checkpoint.runId }),
    await findRunCodeLineage(connection, { projectId: run.projectId, runId: run.id }),
  );
  assertCheckpointArtifactsSaved(checkpoint);
  const resume: RunResumeCheckpointRecord = {
    checkpointId: checkpoint.id,
    sourceRunId: checkpoint.runId,
    step: checkpoint.step,
  };
  await pinRunResumeCheckpoint(connection, {
    runId: run.id,
    checkpointId: checkpoint.id,
    resume,
    parentRunId: checkpoint.runId,
  });
  return findRun(connection, { projectId: run.projectId, id: run.id });
}

/** WorkerJob.resumeCheckpoint for a pinned Run, or null when the Run starts from scratch. */
export async function findWorkerResumeCheckpoint(
  connection: Connection,
  run: Run,
): Promise<WorkerResumeCheckpoint | null> {
  if (!run.resumeCheckpointId) return null;
  const checkpoint = await findCheckpoint(connection, {
    projectId: run.projectId,
    id: run.resumeCheckpointId,
  });
  assertCheckpointArtifactsSaved(checkpoint);
  return {
    id: checkpoint.id,
    runId: checkpoint.runId,
    step: checkpoint.step,
    source: checkpoint.source,
    artifacts: checkpoint.artifacts,
    manifest: checkpoint.manifest,
    metadata: checkpoint.metadata,
  };
}

// Artifact rows are only written after their content is stored, so a missing row is a lost file.
function assertCheckpointArtifactsSaved(checkpoint: RunCheckpoint): void {
  if (checkpoint.artifacts.length !== checkpoint.artifactIds.length)
    throw new DomainError(
      422,
      'checkpointのArtifactが保存されていません',
      'checkpoint_artifact_missing',
    );
}
