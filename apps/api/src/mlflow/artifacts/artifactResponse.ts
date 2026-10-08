import { Readable } from 'node:stream';
import type { Artifact } from '@mmt/contracts';
import type { ArtifactContent } from '@mmt/platform';

export function artifactContentResponse(download: {
  artifact: Artifact;
  content: ArtifactContent;
}): Response {
  const { artifact, content } = download;
  const filename = artifact.path.split('/').at(-1)!;
  const encodedFilename = encodeURIComponent(filename).replace(
    /['()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  const headers: Record<string, string> = {
    'Content-Type': artifact.mimeType,
    'Content-Length': String(content.size),
    'Accept-Ranges': 'bytes',
    'Content-Disposition': `attachment; filename*=UTF-8''${encodedFilename}`,
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "sandbox; default-src 'none'",
    'Cache-Control': 'private, no-store',
    ETag: `"${artifact.sha256}"`,
  };
  if (content.contentRange) headers['Content-Range'] = content.contentRange;
  return new Response(Readable.toWeb(content.body) as ReadableStream<Uint8Array>, {
    status: content.status,
    headers,
  });
}
