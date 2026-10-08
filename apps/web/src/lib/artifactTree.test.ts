import { describe, expect, it } from 'vitest';
import type { Artifact, ArtifactTree } from '@mmt/contracts';
import {
  artifactBreadcrumbs,
  artifactDirectoryRows,
  artifactEntryName,
  previousArtifactVersions,
} from './artifactTree';

function artifact(id: string, path: string): Artifact {
  return {
    id,
    projectId: 'project',
    runId: 'run',
    path,
    backend: 'filesystem',
    storageKey: id,
    mimeType: 'application/octet-stream',
    size: 1,
    sha256: '0'.repeat(64),
    createdAt: '2026-10-08T00:00:00Z',
  };
}

function tree(prefix: string, directories: string[]): ArtifactTree {
  return {
    prefix,
    directories: directories.map((directory) => ({
      prefix: directory,
      fileCount: 1,
      totalSize: 1,
    })),
    directoriesTruncated: false,
    fileCount: 0,
    totalSize: 0,
  };
}

describe('artifactTree', () => {
  it('深い階層のパンくずは、各段がそのディレクトリのprefixを開く', () => {
    expect(artifactBreadcrumbs('audio/2026/10/speaker-1/takes/')).toEqual([
      { name: '', prefix: '' },
      { name: 'audio', prefix: 'audio/' },
      { name: '2026', prefix: 'audio/2026/' },
      { name: '10', prefix: 'audio/2026/10/' },
      { name: 'speaker-1', prefix: 'audio/2026/10/speaker-1/' },
      { name: 'takes', prefix: 'audio/2026/10/speaker-1/takes/' },
    ]);
    expect(artifactBreadcrumbs('')).toEqual([{ name: '', prefix: '' }]);
  });

  it('深い階層では、開いているディレクトリから下の名前だけを表示する', () => {
    const rows = artifactDirectoryRows(tree('a/b/c/', ['a/b/c/d/']), [
      artifact('1', 'a/b/c/file.wav'),
    ]);
    expect(rows.map((row) => [row.kind, row.name])).toEqual([
      ['directory', 'd'],
      ['file', 'file.wav'],
    ]);
  });

  it('同名のファイルとフォルダは両方を、別のkeyで表示する', () => {
    const rows = artifactDirectoryRows(tree('', ['data/']), [artifact('1', 'data')]);
    expect(rows.map((row) => [row.kind, row.name])).toEqual([
      ['directory', 'data'],
      ['file', 'data'],
    ]);
    expect(new Set(rows.map((row) => row.key)).size).toBe(2);
  });

  it('空のpathと空のsegmentは名前なしとして残し、詰めない', () => {
    expect(artifactEntryName('', '')).toBe('');
    expect(artifactEntryName('dir/', 'dir/')).toBe('');
    expect(artifactBreadcrumbs('a//')).toEqual([
      { name: '', prefix: '' },
      { name: 'a', prefix: 'a/' },
      { name: '', prefix: 'a//' },
    ]);
  });

  it('..を含むpathは親へ解決せず、そのままの名前で表示する', () => {
    expect(artifactBreadcrumbs('x/../y/').map((breadcrumb) => breadcrumb.prefix)).toEqual([
      '',
      'x/',
      'x/../',
      'x/../y/',
    ]);
    const rows = artifactDirectoryRows(tree('x/', ['x/../']), [artifact('1', 'x/../secret.txt')]);
    expect(rows.map((row) => row.name)).toEqual(['..', '../secret.txt']);
  });

  it('以前の版は同じpathの別の版だけで、ほかのpathを含めない', () => {
    const current = artifact('3', 'eval/result.json');
    const versions = [
      current,
      artifact('2', 'eval/result.json'),
      artifact('9', 'eval/result.json.bak'),
    ];
    expect(previousArtifactVersions(versions, current).map((item) => item.id)).toEqual(['2']);
  });
});
