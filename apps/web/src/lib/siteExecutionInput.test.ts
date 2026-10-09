import { describe, expect, it } from 'vitest';
import { MAX_JOB_ARRAY_SIZE, MAX_JOB_GPU_COUNT, MAX_QUEUE_TIMEOUT_SECONDS } from '@mmt/contracts';
import { computeTarget, siteTarget } from '../../tests/fixtures/execution';
import {
  buildJobRequest,
  buildJobResources,
  isSiteTarget,
  parseArraySize,
  parseGpuCount,
  parseQueueTimeout,
  parseWalltime,
} from './siteExecutionInput';

const DAY = 24 * 60 * 60;

describe('siteのJobの資源', () => {
  it('GPU数は空なら0（CPUのみ）で、契約の上限を超えると拒否する', () => {
    expect(parseGpuCount('')).toBe(0);
    expect(parseGpuCount('4')).toBe(4);
    expect(parseGpuCount(String(MAX_JOB_GPU_COUNT))).toBe(MAX_JOB_GPU_COUNT);
    for (const value of [String(MAX_JOB_GPU_COUNT + 1), '-1', '1.5', 'two'])
      expect(() => parseGpuCount(value)).toThrow();
  });

  it('制限時間は空ならsiteの既定にし、30日を超えると拒否する', () => {
    expect(parseWalltime('')).toBeNull();
    expect(parseWalltime('12:00:00')).toBe(12 * 60 * 60);
    expect(parseWalltime('720:00:00')).toBe(30 * DAY);
    expect(() => parseWalltime('720:00:01')).toThrow('30日');
    expect(() => parseWalltime('00:00:00')).toThrow();
  });

  it('待ち行列の上限時間はAPIと同じ1分〜30日だけを受け付ける', () => {
    expect(parseQueueTimeout('')).toBeNull();
    expect(parseQueueTimeout('00:01:00')).toBe(60);
    expect(parseQueueTimeout('720:00:00')).toBe(MAX_QUEUE_TIMEOUT_SECONDS);
    expect(() => parseQueueTimeout('00:00:59')).toThrow('1分');
    expect(() => parseQueueTimeout('720:00:01')).toThrow('30日');
  });

  it('arrayの個数は空なら1つのJobで、1〜上限の整数だけを受け付ける', () => {
    expect(parseArraySize('')).toBeNull();
    expect(parseArraySize('64')).toBe(64);
    for (const value of ['0', String(MAX_JOB_ARRAY_SIZE + 1), '2.5'])
      expect(() => parseArraySize(value)).toThrow();
  });

  it('sshのtargetにはGPU IDだけを、siteにはGPU数と制限時間だけを送る', () => {
    const values = { gpuIds: ['1'], gpuCount: '2', walltime: '01:00:00' };
    expect(buildJobResources(computeTarget, values)).toEqual({ gpuIds: ['1'] });
    expect(buildJobResources(siteTarget, { ...values, gpuIds: [] })).toEqual({
      gpuCount: 2,
      walltimeSeconds: 3600,
    });
    expect(isSiteTarget(siteTarget)).toBe(true);
    expect(isSiteTarget(undefined)).toBe(false);
  });

  it('targetに無いGPUと、siteへのGPU IDの指定を拒否する', () => {
    expect(() => buildJobResources(computeTarget, { gpuIds: ['9'] })).toThrow();
    expect(() => buildJobResources(siteTarget, { gpuIds: ['0'], gpuCount: '1' })).toThrow(
      'GPU数',
    );
  });

  it('sshのJobは従来どおりの本文で、自動の再実行はsiteのときだけ送る', () => {
    const values = {
      gpuIds: [],
      gpuCount: '1',
      walltime: '',
      maxAttempts: '3',
      retryOnFailure: 'true',
      retryOnTimeout: 'true',
      allowChildJobs: 'false',
    };
    expect(buildJobRequest(computeTarget, values)).toEqual({
      targetId: 'target',
      maxAttempts: 3,
      gpuIds: [],
    });
    expect(buildJobRequest(siteTarget, { ...values, allowChildJobs: 'true' })).toEqual({
      targetId: 'site',
      maxAttempts: 3,
      gpuCount: 1,
      walltimeSeconds: null,
      retryOnFailure: true,
      retryOnTimeout: true,
      allowChildJobs: true,
    });
  });
});
