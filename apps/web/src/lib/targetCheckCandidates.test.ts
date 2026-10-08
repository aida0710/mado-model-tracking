import { describe, expect, it } from 'vitest';
import type { ComputeTarget, TargetCheck } from '@mmt/contracts';
import { detectedCandidates, hasCandidateChanges, isCheckInProgress } from './targetCheckCandidates';

const finishedCheck: TargetCheck = {
  id: 'check-1',
  targetId: 'target-1',
  requestedBy: 'user-1',
  status: 'finished',
  workerId: 'host-1',
  failureReason: null,
  createdAt: '2026-10-08T00:00:00.000Z',
  claimedAt: '2026-10-08T00:00:01.000Z',
  finishedAt: '2026-10-08T00:00:10.000Z',
  result: {
    version: 1,
    items: [{ name: 'connection', status: 'ok', code: null, detail: null }],
    gpus: [
      { index: '0', uuid: 'GPU-a', name: 'NVIDIA A100', memoryTotalMiB: 81920 },
      { index: '1', uuid: 'GPU-b', name: 'NVIDIA A100', memoryTotalMiB: 81920 },
    ],
    runtimeKinds: ['python', 'docker'],
    workDirectoryFreeBytes: 1,
  },
};

const target = { gpuIds: ['1', '0'], runtimeKinds: ['python'] } as ComputeTarget;

describe('接続確認の候補', () => {
  it('完了した確認だけがnvidia-smiのindexと使えるRuntimeを候補にする', () => {
    expect(detectedCandidates(finishedCheck)).toEqual({
      gpuIds: ['0', '1'],
      runtimeKinds: ['python', 'docker'],
    });
    expect(detectedCandidates({ ...finishedCheck, status: 'claimed', result: null })).toBeNull();
    expect(
      detectedCandidates({ ...finishedCheck, result: { ...finishedCheck.result!, gpus: null } }),
    ).toEqual({ gpuIds: [], runtimeKinds: ['python', 'docker'] });
  });

  it('順序だけが違う候補は変更とみなさない', () => {
    expect(hasCandidateChanges(target, { gpuIds: ['0', '1'], runtimeKinds: ['python'] })).toBe(
      false,
    );
    expect(
      hasCandidateChanges(target, { gpuIds: ['0', '1'], runtimeKinds: ['python', 'docker'] }),
    ).toBe(true);
  });

  it('待機中とclaim済みの確認だけを実行中とする', () => {
    expect(isCheckInProgress({ ...finishedCheck, status: 'queued' })).toBe(true);
    expect(isCheckInProgress({ ...finishedCheck, status: 'claimed' })).toBe(true);
    expect(isCheckInProgress(finishedCheck)).toBe(false);
    expect(isCheckInProgress(undefined)).toBe(false);
  });
});
