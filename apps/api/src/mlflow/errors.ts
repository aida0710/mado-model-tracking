import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { ArtifactRangeError } from '@mmt/platform';
import { DomainError } from '../domain/errors.js';
import { MultipartUploadUnsupportedError } from './artifacts/multipartUnsupported.js';

interface MlflowErrorResponse {
  status: ContentfulStatusCode;
  body: { error_code: string; message: string };
}

const domainErrorCodes: Record<string, string> = {
  already_exists: 'RESOURCE_ALREADY_EXISTS',
  resource_already_exists: 'RESOURCE_ALREADY_EXISTS',
  not_found: 'RESOURCE_DOES_NOT_EXIST',
  resource_does_not_exist: 'RESOURCE_DOES_NOT_EXIST',
  invalid_parameter_value: 'INVALID_PARAMETER_VALUE',
  invalid_request: 'INVALID_PARAMETER_VALUE',
  invalid_json: 'MALFORMED_REQUEST',
  not_implemented: 'NOT_IMPLEMENTED',
  conflict: 'INVALID_STATE',
  body_too_large: 'REQUEST_LIMIT_EXCEEDED',
  artifact_too_large: 'RESOURCE_EXHAUSTED',
  // A protected alias cannot be changed through MLflow (it carries no reason or promotion decision).
  alias_protected: 'PERMISSION_DENIED',
};

export function isMlflowRequest(requestPath: string): boolean {
  return /^\/api\/mlflow\/projects\/[^/]+(?:\/|$)/.test(requestPath);
}

/** Raw Artifact bytes: single-PUT transfers and multipart part PUTs. */
export function isMlflowArtifactUpload(request: { method: string; path: string }): boolean {
  return (
    request.method === 'PUT' &&
    /^\/api\/mlflow\/projects\/[^/]+\/api\/2\.0\/mlflow-artifacts\/(?:artifacts\/.+|mpu\/parts\/[^/]+\/[^/]+)$/.test(
      request.path,
    )
  );
}

export function formatMlflowError(error: Error): MlflowErrorResponse {
  // DomainError has no 501 status; the SDK needs exactly this status and message to fall back.
  if (error instanceof MultipartUploadUnsupportedError)
    return { status: 501, body: { error_code: 'NOT_IMPLEMENTED', message: error.message } };
  if (error instanceof DomainError) {
    const statusCode = error.status;
    const fallbackCode =
      statusCode === 401
        ? 'UNAUTHENTICATED'
        : statusCode === 403
          ? 'PERMISSION_DENIED'
          : statusCode === 404
            ? 'RESOURCE_DOES_NOT_EXIST'
            : statusCode === 409
              ? 'INVALID_STATE'
              : statusCode >= 500
                ? 'TEMPORARILY_UNAVAILABLE'
                : 'INVALID_PARAMETER_VALUE';
    return {
      status: statusCode,
      body: { error_code: domainErrorCodes[error.code] ?? fallbackCode, message: error.message },
    };
  }
  if (error instanceof ArtifactRangeError) {
    return {
      status: 416,
      body: { error_code: 'INVALID_PARAMETER_VALUE', message: '要求されたRangeは読み込めません' },
    };
  }
  const databaseCode = (error as { code?: string }).code;
  if (databaseCode === '23505') {
    return {
      status: 409,
      body: {
        error_code: 'RESOURCE_ALREADY_EXISTS',
        message: '同じ名前または版が既に登録されています',
      },
    };
  }
  if (['23503', '23514', '22P02'].includes(databaseCode ?? '')) {
    return {
      status: 400,
      body: { error_code: 'INVALID_PARAMETER_VALUE', message: '参照または入力値が不正です' },
    };
  }
  return {
    status: 503,
    body: { error_code: 'TEMPORARILY_UNAVAILABLE', message: 'リクエストの処理に失敗しました' },
  };
}
