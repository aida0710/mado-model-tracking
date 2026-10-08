import { serve } from '@hono/node-server';
import { createHarness } from '../apps/api/test/harness.js';

// Isolate early SDK checks from the preview DB while migrations are still being reviewed.
const verificationPort = 4184;
const harness = await createHarness();
const server = serve({ hostname: '127.0.0.1', port: verificationPort, fetch: harness.app.fetch });
console.log(`MLflow verification API listening on 127.0.0.1:${verificationPort}`);

let isClosing = false;
async function shutdown(): Promise<void> {
  if (isClosing) return;
  isClosing = true;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  await harness.close();
}
process.once('SIGINT', () => {
  void shutdown();
});
process.once('SIGTERM', () => {
  void shutdown();
});
