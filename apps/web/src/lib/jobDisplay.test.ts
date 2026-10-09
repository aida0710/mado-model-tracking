import { describe, expect, it } from 'vitest';
import type { JobPhase } from '@mmt/contracts';
import { queuedJob } from '../../tests/fixtures/execution';
import {
  formatAutoRetries,
  jobArrayMemberLabel,
  jobDetailBadge,
  jobGpuSummary,
  jobPhaseText,
  shortId,
} from './jobDisplay';

describe('Jobの段階と終了の理由', () => {
  it.each([
    ['queued', 'waiting_manual', '手動投入待ち', 'status-attention'],
    ['claimed', 'submitting', '投入中', 'status-claimed'],
    ['claimed', 'submitted', '待ち行列', 'status-claimed'],
    ['claimed', 'waiting_resources', 'GPU待ち', 'status-claimed'],
  ] as const)('%s・%sのJobには「%s」を添える', (status, phase, label, className) => {
    expect(jobDetailBadge({ status, phase, endReason: null })).toEqual({ label, className });
  });

  it('状態と同じことしか言わない段階と、段階の無いssh・localのJobには添えない', () => {
    expect(jobDetailBadge({ status: 'running', phase: 'running', endReason: null })).toBeNull();
    expect(jobDetailBadge({ status: 'queued', phase: null, endReason: null })).toBeNull();
  });

  it.each([
    ['timed_out', '時間切れ'],
    ['queue_timeout', '待ち行列の上限'],
    ['submit_failed', '投入失敗'],
  ] as const)('終わったJobには段階ではなく終了の理由%sを添える', (endReason, label) => {
    expect(jobDetailBadge({ status: 'failed', phase: 'submitted', endReason })).toEqual({
      label,
      className: 'status-failed',
    });
    expect(jobDetailBadge({ status: 'finished', phase: 'running', endReason: null })).toBeNull();
  });

  it('段階の詳細は、launcherを待つsiteのJobを待機中として示し、終わったJobは最後の段階を残す', () => {
    expect(jobPhaseText({ status: 'queued', phase: null }, true)).toBe('待機中（launcherの投入待ち）');
    expect(jobPhaseText({ status: 'queued', phase: null }, false)).toBeNull();
    const phases: JobPhase[] = ['waiting_manual', 'submitting', 'submitted', 'waiting_resources', 'running'];
    expect(phases.map((phase) => jobPhaseText({ status: 'canceled', phase }, true))).toEqual([
      '手動投入待ち',
      '投入中',
      '待ち行列',
      'GPU待ち',
      '実行中',
    ]);
  });

  it('GPUは持っているIDを、siteで割り当て前ならGPU数を表示する', () => {
    expect(jobGpuSummary({ gpuIds: ['0', '1'], gpuCount: 2 })).toBe('0, 1');
    expect(jobGpuSummary({ gpuIds: [], gpuCount: 4 })).toBe('GPU ×4');
    expect(jobGpuSummary({ gpuIds: [], gpuCount: 0 })).toBe('CPUのみ');
  });

  it('arrayの番号は0始まりのまま個数と並べ、array外のJobには出さない', () => {
    expect(jobArrayMemberLabel({ arrayIndex: 0, arraySize: 64 })).toBe('0 / 64');
    expect(jobArrayMemberLabel(queuedJob)).toBeNull();
    expect(shortId('0123456789abcdef')).toBe('01234567');
  });

  it('自動の再実行は指定したものだけを並べ、無ければ指定なしにする', () => {
    expect(formatAutoRetries({ retryOnFailure: false, retryOnTimeout: true })).toBe(
      '時間切れなら最新のcheckpointから再実行する',
    );
    expect(formatAutoRetries({ retryOnFailure: false, retryOnTimeout: false })).toBe('指定なし');
  });
});
