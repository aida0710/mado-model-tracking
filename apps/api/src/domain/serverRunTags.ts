// Reserved Run tags (mmt.* is server-only) that arrays and hooks set on the Runs they create.
// Retries copy a Run's tags, so a retry keeps them too.

export const ARRAY_GROUP_TAG = 'mmt.arrayGroupId';
export const ARRAY_INDEX_TAG = 'mmt.arrayIndex';
export const HOOK_TAG = 'mmt.hookId';
export const HOOK_EXECUTION_TAG = 'mmt.hookExecutionId';
// The checkpoint a checkpoint_saved hook hands to its Job (WorkerJob.inputCheckpoint).
export const INPUT_CHECKPOINT_TAG = 'mmt.inputCheckpointId';
