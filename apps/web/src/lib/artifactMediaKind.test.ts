import { describe, expect, it } from 'vitest';
import { artifactMediaKind } from './artifactMediaKind';

describe('artifactMediaKind', () => {
  it.each([
    ['text/csv; charset=utf-8', 'text'],
    ['text/tab-separated-values', 'text'],
    ['application/x-ndjson; charset=utf-8', 'text'],
    ['application/json', 'text'],
    ['image/avif', 'image'],
    ['IMAGE/PNG', 'image'],
    ['audio/flac', 'audio'],
    ['audio/mp4', 'audio'],
    ['audio/aac', 'audio'],
    ['audio/webm', 'audio'],
    ['video/quicktime', 'video'],
    ['video/webm', 'video'],
  ] as const)('%sは%sとして表示する', (mimeType, kind) => {
    expect(artifactMediaKind(mimeType)).toBe(kind);
  });

  it.each(['text/html', 'image/svg+xml', 'application/xml', 'text/javascript', 'audio/x-unknown'])(
    'サーバーがinlineで返さない%sはプレビューしない',
    (mimeType) => {
      expect(artifactMediaKind(mimeType)).toBe('unsupported');
    },
  );
});
