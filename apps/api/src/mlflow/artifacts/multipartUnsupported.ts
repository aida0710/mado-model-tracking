import { Hono } from 'hono';
import { principal, type ApiEnvironment } from '../../http/request.js';

/**
 * Must match mlflow.exceptions._UnsupportedMultipartUploadException.MESSAGE byte for byte.
 * HttpArtifactRepository falls back to a plain PUT only when the error message starts with this
 * text; any other message makes MLFLOW_ENABLE_PROXY_MULTIPART_UPLOAD=true uploads fail.
 */
export const UNSUPPORTED_MULTIPART_UPLOAD_MESSAGE =
  'Multipart upload is not supported for the current artifact repository';

const MULTIPART_UPLOAD_ROOT = '/api/2.0/mlflow-artifacts/mpu';
const MULTIPART_UPLOAD_ACTIONS = ['create', 'complete', 'abort'] as const;

// Replaced by the proxied multipart implementation; until then the SDK streams one PUT instead.
export function multipartUnsupportedRoutes(): Hono<ApiEnvironment> {
  const routes = new Hono<ApiEnvironment>();
  for (const action of MULTIPART_UPLOAD_ACTIONS)
    routes.post(`${MULTIPART_UPLOAD_ROOT}/${action}/*`, (context) => {
      principal(context);
      // DomainError has no 501 status, so answer in the MLflow error shape directly.
      return context.json(
        { error_code: 'NOT_IMPLEMENTED', message: UNSUPPORTED_MULTIPART_UPLOAD_MESSAGE },
        501,
      );
    });
  return routes;
}
