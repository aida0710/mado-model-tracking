// The preview worker process: generates waveform peaks, spectrograms and video posters with
// ffmpeg. It runs apart from the API (compose service `preview`, Dockerfile.preview) so the API
// image carries no ffmpeg and a long decode never competes with request handling.
import { setTimeout as sleep } from 'node:timers/promises';
import { createArtifactStoresFromEnv } from '@mmt/platform';
import { createDatabase } from './db/database.js';
import { loadPreviewWorkerConfig } from './previewWorkerConfig.js';
import { ArtifactPreviewProcessor } from './services/artifactPreviewProcessor.js';
import { ArtifactStoreRegistry } from './services/artifactStoreRegistry.js';

const config = loadPreviewWorkerConfig();
const database = createDatabase(config.databaseUrl);
database.on('error', () => console.error(JSON.stringify({ event: 'database_pool_error' })));
const stores = new ArtifactStoreRegistry({
  database,
  environmentStores: createArtifactStoresFromEnv(),
  secretKey: config.storageSecretKey,
});
const processor = new ArtifactPreviewProcessor({
  database,
  stores,
  tools: {
    ffmpegPath: config.ffmpegPath,
    ffprobePath: config.ffprobePath,
    timeoutMs: config.toolTimeoutMs,
  },
  workDirectory: config.workDirectory,
});

const shutdownSignal = new AbortController();

/**
 * Drains the queue, then waits for the poll interval. Unlike PollingLoop (whose timer is unref'd
 * because the API's HTTP server keeps that process alive), this loop is what keeps this process
 * running. A stop request lets the Artifact in progress finish first.
 */
async function runUntilStopped(): Promise<void> {
  while (!shutdownSignal.signal.aborted) {
    try {
      await stores.ensureLoaded();
      while (!shutdownSignal.signal.aborted && (await processor.processNext()));
    } catch (error) {
      console.error(JSON.stringify({ event: 'artifact_preview_worker_failed', name: (error as Error).name }));
    }
    await sleep(config.pollIntervalMs, undefined, { signal: shutdownSignal.signal }).catch(() => undefined);
  }
}

const running = runUntilStopped();
console.log(JSON.stringify({ event: 'artifact_preview_worker_started' }));

async function shutdown(): Promise<void> {
  if (shutdownSignal.signal.aborted) return;
  shutdownSignal.abort();
  await running;
  await database.end();
}
process.once('SIGTERM', () => {
  void shutdown();
});
process.once('SIGINT', () => {
  void shutdown();
});
