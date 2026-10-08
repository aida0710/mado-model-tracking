import { serve } from '@hono/node-server';
import { createApplication } from './app.js';
import { loadConfig } from './config.js';
import { createDatabase } from './db/database.js';
import { applyIdleTimeout, serverTimeouts } from './http/serverTimeouts.js';

const config = loadConfig();
const database = createDatabase(config.databaseUrl);
database.on('error', () => console.error(JSON.stringify({ event: 'database_pool_error' })));
const {
  app,
  outbox,
  automationSweeper,
  artifactUploadFinalizer,
  artifactGarbageCollector,
  sweepScheduler,
  notificationDispatcher,
  operationsMonitor,
} = createApplication({
  config,
  database,
});
// Background tasks share the server lifetime; stop() waits for the run in progress.
// The garbage collector runs the artifact upload sweeper as part of each collection.
const backgroundTasks = [
  outbox,
  automationSweeper,
  artifactUploadFinalizer,
  artifactGarbageCollector,
  sweepScheduler,
  notificationDispatcher,
  operationsMonitor,
];
const timeouts = serverTimeouts(config);
const server = serve(
  {
    fetch: app.fetch,
    hostname: config.host,
    port: config.port,
    // Node's default 5-minute requestTimeout would cut long single-PUT artifact uploads.
    serverOptions: timeouts.serverOptions,
  },
  (address) => console.log(`API listening on ${config.host}:${address.port}`),
);
applyIdleTimeout(server, timeouts);
for (const task of backgroundTasks) task.start();

let isClosing = false;
async function shutdown(): Promise<void> {
  if (isClosing) return;
  isClosing = true;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  await Promise.all(backgroundTasks.map((task) => task.stop()));
  await database.end();
}
process.once('SIGTERM', () => {
  void shutdown();
});
process.once('SIGINT', () => {
  void shutdown();
});
