import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { isAllowedOrigin, type OriginPolicy } from '../src/http/originPolicy.js';

const policy: OriginPolicy = {
  webOrigin: 'https://tracking.example.test',
  publicUrl: 'https://api.example.test',
  allowPrivateOrigins: true,
};

describe('プライベートネットワークのOrigin許可', () => {
  it.each([
    'http://10.0.0.1:5182',
    'https://10.255.255.255',
    'http://172.16.0.1:5182',
    'http://172.31.255.255:5182',
    'http://192.168.0.1:5182',
    'http://192.168.255.255:5182',
    'http://100.64.0.1:5182',
    'http://100.127.255.255:5182',
    'http://127.0.0.1:5182',
    'http://169.254.0.1:5182',
    'http://localhost:5182',
    'http://preview.localhost:5182',
    'http://[::1]:5182',
    'https://[fc00::1]',
    'http://[fdff::1]:5182',
    'http://[fe80::1]:5182',
    'http://[::ffff:a00:1]:5182',
  ])('%sからのOriginを明示的に有効にすると許可する', (origin) => {
    expect(isAllowedOrigin(origin, policy)).toBe(true);
    expect(isAllowedOrigin(origin, { ...policy, allowPrivateOrigins: false })).toBe(false);
  });

  it.each([
    undefined,
    '',
    'null',
    'http://8.8.8.8:5182',
    'http://172.15.255.255:5182',
    'http://172.32.0.1:5182',
    'http://192.169.0.1:5182',
    'http://100.63.255.255:5182',
    'http://100.128.0.1:5182',
    'http://[2001:4860:4860::8888]:5182',
    'http://[::ffff:808:808]:5182',
    'http://10.0.0.1.attacker.test:5182',
    'http://localhost.attacker.test:5182',
    'http://192.168.1.1@attacker.test:5182',
    'http://user:password@10.0.0.1:5182',
    'http://10.0.0.1:5182/path',
    'http://10.0.0.1:5182?query=1',
    'http://10.0.0.1:5182#fragment',
    'http://0x0a000001:5182',
    'http://r540.lan:5182',
    'ftp://10.0.0.1:5182',
  ])('%sはプライベートOrigin許可が有効でも拒否する', (origin) => {
    expect(isAllowedOrigin(origin, policy)).toBe(false);
  });

  it('明示したDNS名のOriginはプライベート許可の設定によらず使える', () => {
    for (const origin of [policy.webOrigin, policy.publicUrl]) {
      expect(isAllowedOrigin(origin, policy)).toBe(true);
      expect(isAllowedOrigin(origin, { ...policy, allowPrivateOrigins: false })).toBe(true);
    }
  });

  it('設定を省略すると無効になり、trueの明示で有効になる', () => {
    const environment = {
      MMT_DATABASE_URL: 'postgresql://localhost/mmt_test',
      AUTH_MODE: 'development',
    };
    expect(loadConfig(environment).allowPrivateOrigins).toBe(false);
    expect(loadConfig({ ...environment, MMT_ALLOW_PRIVATE_ORIGINS: 'true' }).allowPrivateOrigins)
      .toBe(true);
    expect(loadConfig({ ...environment, MMT_ALLOW_PRIVATE_ORIGINS: 'false' }).allowPrivateOrigins)
      .toBe(false);
    expect(() => loadConfig({ ...environment, MMT_ALLOW_PRIVATE_ORIGINS: 'yes' })).toThrow(
      'MMT_ALLOW_PRIVATE_ORIGINS',
    );
  });
});
