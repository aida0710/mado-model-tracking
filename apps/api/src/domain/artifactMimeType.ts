export const FALLBACK_ARTIFACT_MIME_TYPE = 'application/octet-stream';

// Inferred text types declare UTF-8 so inline previews of Japanese labels are not mis-decoded.
const UTF8_TEXT = '; charset=utf-8';

// HTML, SVG, XML, and JavaScript are never inferred: a guessed active type must not reach a browser.
const mimeTypesByExtension: Record<string, string> = {
  wav: 'audio/wav',
  flac: 'audio/flac',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  // Opus files are stored in an Ogg container; browsers play them through the Ogg type.
  opus: 'audio/ogg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  webm: 'video/webm',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  avif: 'image/avif',
  gif: 'image/gif',
  csv: `text/csv${UTF8_TEXT}`,
  tsv: `text/tab-separated-values${UTF8_TEXT}`,
  jsonl: `application/x-ndjson${UTF8_TEXT}`,
  txt: `text/plain${UTF8_TEXT}`,
  npy: 'application/x-npy',
  parquet: 'application/vnd.apache.parquet',
};

// Passive media and plain text only; every other type is served as an attachment.
const inlineMimeTypes = new Set([
  'text/plain',
  'text/csv',
  'text/tab-separated-values',
  'application/json',
  'application/x-ndjson',
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/avif',
  'image/gif',
  'audio/wav',
  'audio/x-wav',
  'audio/flac',
  'audio/x-flac',
  'audio/mpeg',
  'audio/ogg',
  'audio/opus',
  'audio/mp4',
  'audio/aac',
  'audio/webm',
  'video/mp4',
  'video/webm',
  'video/quicktime',
]);

const MIME_TYPE_PATTERN = /^[\w!#$&^.+-]+\/[\w!#$&^.+-]+(?:;[^\r\n]*)?$/;

export function essenceOfMimeType(mimeType: string): string {
  return mimeType.split(';')[0]!.trim().toLowerCase();
}

export function inferMimeTypeFromPath(path: string): string | null {
  const filename = path.split('/').at(-1) ?? '';
  const dot = filename.lastIndexOf('.');
  if (dot <= 0) return null;
  return mimeTypesByExtension[filename.slice(dot + 1).toLowerCase()] ?? null;
}

/** Keeps a specific client-declared type and infers from the extension only when none was given. */
export function resolveArtifactMimeType(upload: {
  path: string;
  declaredMimeType?: string;
}): string {
  const declared = upload.declaredMimeType?.trim() ?? '';
  const isSpecific =
    MIME_TYPE_PATTERN.test(declared) && essenceOfMimeType(declared) !== FALLBACK_ARTIFACT_MIME_TYPE;
  if (isSpecific) return declared;
  return inferMimeTypeFromPath(upload.path) ?? FALLBACK_ARTIFACT_MIME_TYPE;
}

export function isInlineArtifactMimeType(mimeType: string): boolean {
  return inlineMimeTypes.has(essenceOfMimeType(mimeType));
}
