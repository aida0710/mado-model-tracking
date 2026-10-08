import { Readable } from 'node:stream';
import type { ReadableStream } from 'node:stream/web';
import type { ApiContext } from './request.js';

/**
 * The request body as a Node stream for storage writes. A client that disconnects while the
 * permission check runs destroys the stream before storage reads it; without a listener that
 * error is uncaught and stops the process. Storage still sees the destroyed stream and fails.
 */
export function requestBodyStream(context: ApiContext): Readable {
  const body = context.req.raw.body;
  const readable = body ? Readable.fromWeb(body as ReadableStream<Uint8Array>) : Readable.from([]);
  readable.on('error', () => undefined);
  return readable;
}

/** Content-Length of a raw upload; storage needs the size before reading the body. */
export function declaredContentLength(context: ApiContext): number | undefined {
  const header = context.req.header('Content-Length');
  return header && /^\d+$/.test(header) ? Number(header) : undefined;
}
