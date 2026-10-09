import { describe, expect, it } from 'vitest';
import type { Job } from '@mmt/contracts';
import { queuedJob } from '../../tests/fixtures/execution';
import { summarizeJobArrays } from './jobArrays';

const member = (index: number, overrides: Partial<Job> = {}): Job => ({
  ...queuedJob,
  id: `job-${index}-${overrides.attempt ?? 1}`,
  targetId: 'site',
  arrayGroupId: 'array-1',
  arrayIndex: index,
  arraySize: 4,
  createdAt: `2026-10-09T00:00:0${index}Z`,
  ...overrides,
});

describe('Job arrayのまとめ', () => {
  it('再実行した番号は最新の試行だけを数え、array外のJobは含めない', () => {
    const summaries = summarizeJobArrays([
      member(0, { status: 'finished' }),
      member(1, { status: 'failed', attempt: 1 }),
      member(1, { status: 'running', attempt: 2 }),
      member(2, { status: 'claimed', phase: 'submitted' }),
      member(3),
      { ...queuedJob, id: 'single' },
    ]);
    expect(summaries).toEqual([
      {
        arrayGroupId: 'array-1',
        targetId: 'site',
        size: 4,
        hookId: null,
        parentJobId: null,
        createdAt: '2026-10-09T00:00:00Z',
        counts: { finished: 1, running: 1, claimed: 1, queued: 1 },
      },
    ]);
  });

  it('arrayは一覧の順（新しい順）に並べ、起動したフックと親Jobを引き継ぐ', () => {
    const summaries = summarizeJobArrays([
      member(0, { arrayGroupId: 'newer', hookId: 'hook', parentJobId: 'driver' }),
      member(0, { arrayGroupId: 'older' }),
    ]);
    expect(summaries.map((summary) => summary.arrayGroupId)).toEqual(['newer', 'older']);
    expect(summaries[0]).toMatchObject({ hookId: 'hook', parentJobId: 'driver' });
  });
});
