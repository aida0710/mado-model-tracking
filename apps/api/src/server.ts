import { serve } from '@hono/node-server';
import { createApplication } from './app.js';
import { loadConfig } from './config.js';
import { createDatabase } from './db/database.js';

const config = loadConfig();
const database = createDatabase(config.databaseUrl);
database.on('error', () => console.error(JSON.stringify({ event: 'database_pool_error' })));
const { app, outbox } = createApplication({ config, database });
const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (address) =>
  console.log(`API listening on ${config.host}:${address.port}`),
);
outbox.start();

let isClosing = false;
async function shutdown(): Promise<void> {
  if (isClosing) return;
  isClosing = true;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  await outbox.stop();
  await database.end();
}
process.once('SIGTERM', () => {
  void shutdown();
});
process.once('SIGINT', () => {
  void shutdown();
});
