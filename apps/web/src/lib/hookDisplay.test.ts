import { describe, expect, it } from 'vitest';
import type { HookJobTemplate } from '@mmt/contracts';
import { executionCatalog } from '../../tests/fixtures/execution';
import {
  hookExecutionOutcome,
  hookFilterEntries,
  hookResourceSummary,
  hookWebhookPath,
} from './hookDisplay';

const template = {
  gpuIds: [],
  gpuCount: 2,
  walltimeSeconds: 3600,
  arraySize: 64,
} as unknown as HookJobTemplate;

describe('フックの表示', () => {
  it('起動しなかった実行は理由を添え、それ以外は状態を表示する', () => {
    expect(hookExecutionOutcome({ status: 'skipped', reason: 'rate_limited' })).toBe(
      '起動せず（1時間あたりの起動回数の上限）',
    );
    expect(hookExecutionOutcome({ status: 'skipped', reason: 'chain_too_deep' })).toContain('10段');
    expect(hookExecutionOutcome({ status: 'queued', reason: null })).toBe('Jobを登録');
    expect(hookExecutionOutcome({ status: 'pending', reason: null })).toBe('Runの終了待ち');
  });

  it('webhookの受け口はフックのIDのpathにする', () => {
    expect(hookWebhookPath('hook-1')).toBe('/api/hooks/hook-1/webhook');
  });

  it('絞り込みは設定した条件だけを、実験の名前で並べる', () => {
    expect(
      hookFilterEntries(
        { experimentIds: ['experiment', 'gone'], runStatuses: ['failed'], tags: { suite: 'a' } },
        executionCatalog,
      ),
    ).toEqual([
      ['実験', 'Evaluation, gone'],
      ['Runの終了状態', '失敗'],
      ['Runのタグ（JSON・すべて一致）', '{"suite":"a"}'],
    ]);
    expect(hookFilterEntries({}, executionCatalog)).toEqual([]);
  });

  it('siteのJobはGPU数・制限時間・arrayを、sshのJobはGPU IDを示す', () => {
    expect(hookResourceSummary(template, true)).toBe('GPU ×2 · 制限時間 01:00:00 · array ×64');
    expect(hookResourceSummary({ ...template, gpuIds: ['0'], gpuCount: 1 }, false)).toBe('0');
  });
});
