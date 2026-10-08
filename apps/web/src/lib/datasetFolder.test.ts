import { describe, expect, it } from 'vitest';
import type { UploadSource } from './droppedFiles';
import { datasetPathsOf, planDatasetFolder } from './datasetFolder';

const source = (relativePath: string): UploadSource => ({
  file: new File(['x'], relativePath.split('/').pop()!),
  relativePath,
});

describe('datasetPathsOf', () => {
  it('フォルダを選ぶと、全ファイルに共通するフォルダ名を除いたパスになる', () => {
    expect(datasetPathsOf([source('corpus/train/a.wav'), source('corpus/meta.jsonl')])).toEqual([
      'train/a.wav',
      'meta.jsonl',
    ]);
  });

  it('ばらばらに選んだファイルや、最上位が異なるファイルはそのままのパスになる', () => {
    expect(datasetPathsOf([source('a.wav'), source('b.wav')])).toEqual(['a.wav', 'b.wav']);
    expect(datasetPathsOf([source('one/a.wav'), source('two/b.wav')])).toEqual([
      'one/a.wav',
      'two/b.wav',
    ]);
  });
});

describe('planDatasetFolder', () => {
  it('uploadごとに別のArtifactフォルダへ置き、データセット内のパスは保つ', () => {
    const [entry] = planDatasetFolder([source('corpus/train/a.wav')], {
      datasetId: 'dataset-1',
      uploadId: 'upload-1',
    });
    expect(entry).toMatchObject({
      datasetPath: 'train/a.wav',
      artifactPath: 'datasets/dataset-1/upload-1/train/a.wav',
    });
  });
});
