import { describe, expect, it } from 'vitest';
import { HOOK_PAYLOAD_MAX_BYTES } from '@mmt/contracts';
import { buildHookStartRequest, createHookStartKey } from './hookStart';

describe('手動のフックの起動', () => {
  it('本文が空なら送らず、JSONオブジェクトならそのまま送る', () => {
    expect(buildHookStartRequest('  ', 'key')).toEqual({ idempotencyKey: 'key' });
    expect(buildHookStartRequest('{"shard":3}', 'key')).toEqual({
      payload: { shard: 3 },
      idempotencyKey: 'key',
    });
  });

  it('オブジェクトでない本文と、APIの上限を超える本文を拒否する', () => {
    expect(() => buildHookStartRequest('[1,2]', 'key')).toThrow();
    expect(() => buildHookStartRequest('{', 'key')).toThrow();
    const large = JSON.stringify({ text: 'x'.repeat(HOOK_PAYLOAD_MAX_BYTES) });
    expect(() => buildHookStartRequest(large, 'key')).toThrow('256KiB');
  });

  it('起動ごとに別の重複防止キーを作る', () => {
    const key = createHookStartKey();
    expect(key).toMatch(/^[0-9a-f]{32}$/);
    expect(createHookStartKey()).not.toBe(key);
  });
});
