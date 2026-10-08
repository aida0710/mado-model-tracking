import { describe, expect, it } from 'vitest';
import { automationSkipReason } from './automationSkipReason';

describe('前の段を待った自動実行のskip理由', () => {
  it('学習失敗と期限切れのskipはerrorのcodeから理由を返す', () => {
    expect(
      automationSkipReason({ status: 'skipped', error: 'source_run_unsuccessful: 学習Runが失敗' }),
    ).toBe('source_run_unsuccessful');
    expect(automationSkipReason({ status: 'skipped', error: 'source_run_timeout: 期限切れ' })).toBe(
      'source_run_timeout',
    );
  });
  it('上流の段の失敗と出力Datasetなしのskipも理由を返す', () => {
    expect(
      automationSkipReason({ status: 'skipped', error: 'upstream_unsuccessful: 推論Runが失敗' }),
    ).toBe('upstream_unsuccessful');
    expect(
      automationSkipReason({ status: 'skipped', error: 'upstream_outputs_missing: 出力なし' }),
    ).toBe('upstream_outputs_missing');
  });
  it('ほかの理由のskipやskip以外の結果では理由を返さない', () => {
    expect(automationSkipReason({ status: 'skipped', error: 'weights_required: 重みなし' })).toBe(
      null,
    );
    expect(automationSkipReason({ status: 'failed', error: 'source_run_timeout: x' })).toBe(null);
    expect(automationSkipReason({ status: 'pending', error: null })).toBe(null);
  });
});
