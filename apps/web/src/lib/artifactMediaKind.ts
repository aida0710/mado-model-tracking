// Mirrors the API's inline MIME list (apps/api/src/domain/artifactMimeType.ts): the browser can only
// render what the server serves inline, so both sides must change together.
export type ArtifactMediaKind = 'text' | 'image' | 'audio' | 'video' | 'unsupported';

const mediaKindsByMimeType: Record<string, ArtifactMediaKind> = {
  'text/plain': 'text',
  'text/csv': 'text',
  'text/tab-separated-values': 'text',
  'application/json': 'text',
  'application/x-ndjson': 'text',
  'image/png': 'image',
  'image/jpeg': 'image',
  'image/webp': 'image',
  'image/avif': 'image',
  'image/gif': 'image',
  'audio/wav': 'audio',
  'audio/x-wav': 'audio',
  'audio/flac': 'audio',
  'audio/x-flac': 'audio',
  'audio/mpeg': 'audio',
  'audio/ogg': 'audio',
  'audio/opus': 'audio',
  'audio/mp4': 'audio',
  'audio/aac': 'audio',
  'audio/webm': 'audio',
  'video/mp4': 'video',
  'video/webm': 'video',
  'video/quicktime': 'video',
};

export function artifactMediaKind(mimeType: string): ArtifactMediaKind {
  const essence = mimeType.split(';')[0]!.trim().toLowerCase();
  return mediaKindsByMimeType[essence] ?? 'unsupported';
}
