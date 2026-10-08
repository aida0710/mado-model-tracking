import type { ServerOptions } from 'node:http';
import type { ApiConfig } from '../config.js';

// Slowloris defence: a client must finish sending headers within this time even when the
// whole-request deadline is disabled for multi-hour artifact uploads.
const HEADERS_TIMEOUT_MS = 60_000;

export interface ServerTimeouts {
  serverOptions: Pick<ServerOptions, 'requestTimeout' | 'headersTimeout'>;
  /** Socket inactivity limit; a stalled upload is cut instead of holding a connection forever. */
  idleTimeoutMs: number;
}

export function serverTimeouts(
  config: Pick<ApiConfig, 'uploadRequestTimeoutMs' | 'uploadIdleTimeoutMs'>,
): ServerTimeouts {
  const requestTimeout = config.uploadRequestTimeoutMs;
  return {
    serverOptions: {
      requestTimeout,
      // Node rejects a headers timeout longer than a non-zero request timeout.
      headersTimeout:
        requestTimeout > 0 ? Math.min(HEADERS_TIMEOUT_MS, requestTimeout) : HEADERS_TIMEOUT_MS,
    },
    idleTimeoutMs: config.uploadIdleTimeoutMs,
  };
}

export function applyIdleTimeout(
  server: { setTimeout(milliseconds: number): unknown },
  timeouts: ServerTimeouts,
) {
  // Without a 'timeout' listener Node destroys the idle socket, which aborts the upload stream.
  server.setTimeout(timeouts.idleTimeoutMs);
}
