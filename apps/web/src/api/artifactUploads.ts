import type {
  ApiError,
  Artifact,
  ArtifactUpload,
  ArtifactUploadCreate,
  ArtifactUploadDetail,
  ArtifactUploadPart,
  ArtifactUploadStatus,
} from '@mmt/contracts';
import {
  ARTIFACT_TOO_LARGE_CODE,
  encodeId,
  invalidResponseError,
  jsonRequest,
  NETWORK_ERROR_CODE,
  projectPath,
  request,
  RequestError,
  requestItems,
} from './http';

const HTTP_PAYLOAD_TOO_LARGE = 413;
// Same header name as apps/api/src/routes/artifactUploadRoutes.ts PART_SHA256_HEADER.
const PART_SHA256_HEADER = 'X-Part-SHA256';

const uploadsPath = (projectId: string) => `${projectPath(projectId)}/artifact-uploads`;
const uploadPath = (projectId: string, uploadId: string) =>
  `${uploadsPath(projectId)}/${encodeId(uploadId)}`;

export interface TransferOptions {
  signal: AbortSignal;
  /** Bytes of this request body sent so far. */
  onProgress: (sentBytes: number) => void;
}

/**
 * fetch() cannot report upload progress, so request bodies go through XMLHttpRequest.
 * Failures become the same RequestError as api/http.ts so lib/errorMessage.ts can show them.
 */
function sendWithProgress<T>(
  { method, path, body, headers }: { method: 'PUT'; path: string; body: Blob | ArrayBuffer; headers: Record<string, string> },
  { signal, onProgress }: TransferOptions,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('Upload aborted', 'AbortError'));
      return;
    }
    const xhr = new XMLHttpRequest();
    const abort = () => xhr.abort();
    signal.addEventListener('abort', abort, { once: true });
    const settle = (finish: () => void) => {
      signal.removeEventListener('abort', abort);
      finish();
    };
    xhr.open(method, `/api${path}`);
    xhr.withCredentials = true;
    for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value);
    xhr.upload.onprogress = (event) => onProgress(event.loaded);
    xhr.onabort = () => settle(() => reject(new DOMException('Upload aborted', 'AbortError')));
    xhr.onerror = () => settle(() => reject(new RequestError({ status: 0, code: NETWORK_ERROR_CODE })));
    xhr.onload = () =>
      settle(() => {
        const payload = parseJson(xhr.responseText);
        if (xhr.status < 200 || xhr.status >= 300) reject(responseError(xhr.status, payload));
        else if (payload === null) reject(invalidResponseError(xhr.status));
        else resolve(payload as T);
      });
    xhr.send(body);
  });
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

function responseError(status: number, payload: unknown): RequestError {
  // A front proxy can reject with HTML before the API, so 413 is named by status alone.
  if (status === HTTP_PAYLOAD_TOO_LARGE) return new RequestError({ status, code: ARTIFACT_TOO_LARGE_CODE });
  const apiError = payload as Partial<ApiError> | null;
  return new RequestError({
    status,
    code: typeof apiError?.code === 'string' ? apiError.code : undefined,
    serverMessage: typeof apiError?.error === 'string' ? apiError.error : undefined,
  });
}

export const artifactUploadsApi = {
  list: (projectId: string, status: ArtifactUploadStatus, signal?: AbortSignal) =>
    requestItems<ArtifactUpload>(`${uploadsPath(projectId)}?${new URLSearchParams({ status })}`, signal),
  get: (projectId: string, uploadId: string, signal?: AbortSignal) =>
    request<ArtifactUploadDetail>(uploadPath(projectId, uploadId), { signal }),
  create: (projectId: string, body: ArtifactUploadCreate, signal?: AbortSignal) =>
    request<ArtifactUpload>(uploadsPath(projectId), { ...jsonRequest('POST', body), signal }),
  putPart: (
    { projectId, uploadId, partNumber, body, sha256 }: {
      projectId: string;
      uploadId: string;
      partNumber: number;
      body: Blob | ArrayBuffer;
      /** Lowercase hex digest; omitted where the browser has no Web Crypto (plain http origins). */
      sha256: string | null;
    },
    options: TransferOptions,
  ) =>
    sendWithProgress<ArtifactUploadPart>(
      {
        method: 'PUT',
        path: `${uploadPath(projectId, uploadId)}/parts/${partNumber}`,
        body,
        headers: {
          'Content-Type': 'application/octet-stream',
          ...(sha256 ? { [PART_SHA256_HEADER]: sha256 } : {}),
        },
      },
      options,
    ),
  complete: (projectId: string, uploadId: string, signal?: AbortSignal) =>
    request<ArtifactUpload>(`${uploadPath(projectId, uploadId)}/complete`, { method: 'POST', signal }),
  abort: (projectId: string, uploadId: string) =>
    request<ArtifactUpload>(uploadPath(projectId, uploadId), { method: 'DELETE' }),
  /** The single PUT of `PUT .../artifacts?path=`, sent with progress for small files. */
  putSingle: (
    { projectId, runId, path, file }: { projectId: string; runId: string | null; path: string; file: File },
    options: TransferOptions,
  ) =>
    sendWithProgress<Artifact>(
      {
        method: 'PUT',
        path: `${runId ? `${projectPath(projectId)}/runs/${encodeId(runId)}` : projectPath(projectId)}/artifacts?${new URLSearchParams({ path })}`,
        body: file,
        // The API infers the type from the path when the browser leaves File.type empty.
        headers: { 'Content-Type': file.type || 'application/octet-stream' },
      },
      options,
    ),
};
