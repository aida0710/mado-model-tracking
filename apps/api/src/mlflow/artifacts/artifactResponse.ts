import { Readable } from 'node:stream';
import type { Artifact } from '@mmt/contracts';
import type { ArtifactContent } from '@mmt/platform';
import {
  artifactContentHeaders,
  MUTABLE_ARTIFACT_CACHE_CONTROL,
} from '../../http/artifactContentHeaders.js';

export function artifactContentResponse(download: {
  artifact: Artifact;
  content: ArtifactContent;
}): Response {
  // MLflow clients download files; inline rendering is reserved for the native preview URL.
  const headers = artifactContentHeaders({
    ...download,
    disposition: 'attachment',
    cacheControl: MUTABLE_ARTIFACT_CACHE_CONTROL,
  });
  return new Response(Readable.toWeb(download.content.body) as ReadableStream<Uint8Array>, {
    status: download.content.status,
    headers,
  });
}
