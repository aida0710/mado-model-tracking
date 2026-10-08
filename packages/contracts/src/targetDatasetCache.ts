/**
 * How a worker brings an input DatasetVersion's files to the target. 'relay': the worker downloads
 * from the API and forwards them (GPU hosts often cannot reach the API). 'direct': the target
 * downloads from the API itself with the Job token.
 */
export type DatasetTransferMode = 'relay' | 'direct';

export const DATASET_TRANSFER_MODES: readonly DatasetTransferMode[] = ['relay', 'direct'];

/** Same as the migration default: room for typical audio corpora next to model weights. */
export const DEFAULT_DATASET_CACHE_MAX_BYTES = 100 * 1024 ** 3;

/** Below this a cache could not hold even a small evaluation set; it is most likely a typo. */
export const MIN_DATASET_CACHE_MAX_BYTES = 1024 ** 2;
