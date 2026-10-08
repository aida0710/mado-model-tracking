import { Hono } from 'hono';
import { principal, type ApiEnvironment } from '../../http/request.js';
import { MULTIPART_UPLOAD_ROOT } from './multipartProtocol.js';

/**
 * Must match mlflow.exceptions._UnsupportedMultipartUploadException.MESSAGE byte for byte.
 * HttpArtifactRepository falls back to a plain PUT only when the error message starts with this
 * text; any other message makes the multipart upload fail.
 */
export const UNSUPPORTED_MULTIPART_UPLOAD_MESSAGE =
  'Multipart upload is not supported for the current artifact repository';

const MULTIPART_UPLOAD_ACTIONS = ['create', 'complete', 'abort'] as const;

/**
 * Answered as 501 with the SDK's message, so the SDK sends the same file as one streamed PUT.
 * Used for uploads the session API cannot take, such as an empty file or a backend without
 * multipart support.
 */
export class MultipartUploadUnsupportedError extends Error {
  constructor() {
    super(UNSUPPORTED_MULTIPART_UPLOAD_MESSAGE);
    this.name = 'MultipartUploadUnsupportedError';
  }
}

// Mounted when MMT_MLFLOW_MULTIPART_UPLOADS=false; SDKs forced to multipart then stream one PUT.
export function multipartUnsupportedRoutes(): Hono<ApiEnvironment> {
  const routes = new Hono<ApiEnvironment>();
  for (const action of MULTIPART_UPLOAD_ACTIONS)
    routes.post(`${MULTIPART_UPLOAD_ROOT}/${action}/*`, (context) => {
      principal(context);
      throw new MultipartUploadUnsupportedError();
    });
  return routes;
}
