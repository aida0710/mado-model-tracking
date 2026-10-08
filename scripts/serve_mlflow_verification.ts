import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { createHarness } from '../apps/api/test/harness.js';

// Isolate early SDK checks from the preview DB while migrations are still being reviewed.
const DEFAULT_VERIFICATION_PORT = 4184;
const verificationPort = Number(process.env.MMT_VERIFY_API_PORT ?? DEFAULT_VERIFICATION_PORT);
const harness = await createHarness();
// MLflow's mpu/complete waits for the finalizer, which the server normally runs in the background.
harness.artifactUploadFinalizer.start();
const app = new Hono();
// Multipart checks count the part requests the SDK sent; only the path and status are logged.
app.use('/api/mlflow/*', async (context, next) => {
  await next();
  if (context.req.path.includes('/mlflow-artifacts/mpu/'))
    console.log(
      JSON.stringify({
        event: 'mlflow_multipart_request',
        method: context.req.method,
        path: context.req.path,
        status: context.res.status,
      }),
    );
});
app.route('/', harness.app);
const server = serve({ hostname: '127.0.0.1', port: verificationPort, fetch: app.fetch });
console.log(`MLflow verification API listening on 127.0.0.1:${verificationPort}`);

let isClosing = false;
async function shutdown(): Promise<void> {
  if (isClosing) return;
  isClosing = true;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  await harness.artifactUploadFinalizer.stop();
  await harness.close();
}
process.once('SIGINT', () => {
  void shutdown();
});
process.once('SIGTERM', () => {
  void shutdown();
});
