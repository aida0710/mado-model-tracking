// JSON body limits of the native API. app.ts enforces them and the OpenAPI document publishes them.

// Registry JSON and code uploads are bounded separately from streamed artifact bodies.
export const MAX_JSON_BODY_BYTES = 4 * 1024 * 1024;
// An offline sync batch carries up to 10000 metrics and 10000 log lines in one JSON body.
export const SYNC_BATCH_MAX_BYTES = 32 * 1024 * 1024;
// A DatasetVersion lists up to MAX_DATASET_VERSION_FILES files of up to 1024-character paths
// (about 1.1 KB each with the Artifact ID), so its creation request gets a larger JSON limit.
export const MAX_DATASET_VERSION_BODY_BYTES = 128 * 1024 * 1024;
