import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { datasetManifestDigest } from './datasetManifestDigest.js';

const entries = [
  { path: 'train/b.wav', sha256: 'b'.repeat(64), size: 20 },
  { path: 'train/a.wav', sha256: 'a'.repeat(64), size: 10 },
  { path: 'README.md', sha256: 'c'.repeat(64), size: 3 },
];

describe('datasetManifestDigest', () => {
  it('ファイルの並び順が違っても同じdigestになる', () => {
    expect(datasetManifestDigest([...entries].reverse())).toBe(datasetManifestDigest(entries));
  });

  it('sizeが1違う、sha256が1文字違う、pathが違うとdigestが変わる', () => {
    const digest = datasetManifestDigest(entries);
    const changed = [
      entries.map((entry, index) => (index === 0 ? { ...entry, size: entry.size + 1 } : entry)),
      entries.map((entry, index) => (index === 0 ? { ...entry, sha256: `d${entry.sha256.slice(1)}` } : entry)),
      entries.map((entry, index) => (index === 0 ? { ...entry, path: 'train/c.wav' } : entry)),
    ];
    for (const manifest of changed) expect(datasetManifestDigest(manifest)).not.toBe(digest);
  });

  it('pathをUTF-8のbyte順に並べた正規化JSONのsha256をsha256:付きで返す', () => {
    // UTF-16 code units put U+1F600 (a surrogate pair) first; UTF-8 bytes put U+FF21 first.
    const manifest = [
      { path: '\u{1F600}.wav', sha256: 'e'.repeat(64), size: 1 },
      { path: 'Ａ.wav', sha256: 'f'.repeat(64), size: 2 },
    ];
    const expected = JSON.stringify([
      { path: 'Ａ.wav', sha256: 'f'.repeat(64), size: 2 },
      { path: '\u{1F600}.wav', sha256: 'e'.repeat(64), size: 1 },
    ]);
    expect(datasetManifestDigest(manifest)).toBe(
      `sha256:${createHash('sha256').update(expected, 'utf8').digest('hex')}`,
    );
    // python/tests/test_dataset_upload.py checks the SDK against the same value.
    expect(datasetManifestDigest(manifest)).toBe(
      'sha256:710944fa3af4b732ca1b3b5f64a70e3bfcffd96c6ddddd094caf21c8d2e71157',
    );
  });
});
