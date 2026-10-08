import type { Run } from '@mmt/contracts';

/**
 * An evaluation Run's inputs have two roles:
 * - upstream outputs (Run.upstreamDatasetVersionIds): DatasetVersions produced by an upstream Run
 *   such as the predictions of an inference Run. They differ for every model version.
 * - the reference set (正解セット): every other input, i.e. the fixed evaluation data such as
 *   ground-truth transcripts and test audio. This plays the role of MLflow's dataset context.
 *
 * Two evaluations are comparable only when their reference sets are equal; comparing the full
 * input lists would never match because the upstream outputs always differ. The automation chain
 * (automation-stage-chaining-api) fills upstreamDatasetVersionIds. Manually created Runs leave it
 * empty, so all of their inputs form the reference set.
 */
export function referenceDatasetVersionIds(
  run: Pick<Run, 'inputDatasetVersionIds' | 'upstreamDatasetVersionIds'>,
): string[] {
  const upstream = new Set(run.upstreamDatasetVersionIds);
  return [...new Set(run.inputDatasetVersionIds.filter((id) => !upstream.has(id)))].sort();
}

