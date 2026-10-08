import process from 'node:process';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

// Verification runs point the dev proxy at an isolated API; the default is the shared dev API.
const apiProxyTarget = process.env.MMT_WEB_API_PROXY_TARGET ?? 'http://127.0.0.1:4182';

/**
 * MLflow clients upload through this dev server (MLFLOW_TRACKING_URI uses the Web port), and Node's
 * default 5-minute requestTimeout would cut long single-PUT artifact uploads before the API sees
 * the end. The API keeps its own idle timeout, so this port does not need a whole-request deadline.
 */
function removeRequestTimeout(httpServer: object | null) {
  if (httpServer && 'requestTimeout' in httpServer) httpServer.requestTimeout = 0;
}

function disableRequestTimeout(): Plugin {
  return {
    name: 'mmt-disable-request-timeout',
    configureServer(server) {
      removeRequestTimeout(server.httpServer);
    },
    configurePreviewServer(server) {
      removeRequestTimeout(server.httpServer);
    },
  };
}

export default defineConfig({
  plugins: [react(), disableRequestTimeout()],
  server: {
    host: '0.0.0.0',
    port: 5182,
    strictPort: true,
    // Route API preflights to the API's Origin policy instead of Vite's asset CORS middleware.
    cors: false,
    proxy: { '/api': apiProxyTarget },
  },
});
