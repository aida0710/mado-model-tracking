// Tags the sweep controller sets on trial Runs (apps/api services/sweepController.ts).

/** The sweep a trial Run belongs to. */
export const SWEEP_ID_TAG = 'mmt.sweepId';
/**
 * Set on a trial the sweep stopped early. The Run itself ends canceled, as MLflow has no
 * early-stopped status, so the tag tells the two apart.
 */
export const SWEEP_EARLY_STOPPED_TAG = 'mmt.sweepEarlyStopped';
