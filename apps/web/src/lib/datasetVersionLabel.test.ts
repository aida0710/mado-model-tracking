import { describe, expect, it } from 'vitest';
import type { DatasetVersion } from '@mmt/contracts';
import { datasetVersionLabel } from './datasetVersionLabel';

const version = { id: 'v1', datasetId: 'corpus', namespace: 'speech', name: 'vowels', version: '1' } as DatasetVersion;

describe('datasetVersionLabel', () => {
  it('同じデータセットの親はバージョンだけ、別のデータセットの親は名前付きで表す', () => {
    expect(datasetVersionLabel(version, 'corpus')).toBe('1');
    expect(datasetVersionLabel(version, 'other')).toBe('speech/vowels / 1');
  });
});
