import { describe, expect, it } from 'vitest';
import { sourceRunSkipReason } from './automationSourceRunSkip';

describe('学習Runを待った自動実行のskip理由', () => {
  it('学習失敗と期限切れのskipはerrorのcodeから理由を返す', () => {
    expect(
      sourceRunSkipReason({ status: 'skipped', error: 'source_run_unsuccessful: 学習Runが失敗' }),
    ).toBe('source_run_unsuccessful');
    expect(sourceRunSkipReason({ status: 'skipped', error: 'source_run_timeout: 期限切れ' })).toBe(
      'source_run_timeout',
    );
  });
  it('ほかの理由のskipやskip以外の結果では理由を返さない', () => {
    expect(sourceRunSkipReason({ status: 'skipped', error: 'weights_required: 重みなし' })).toBe(
      null,
    );
    expect(sourceRunSkipReason({ status: 'failed', error: 'source_run_timeout: x' })).toBe(null);
    expect(sourceRunSkipReason({ status: 'pending', error: null })).toBe(null);
  });
});
