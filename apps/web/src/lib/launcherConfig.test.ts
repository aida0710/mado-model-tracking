import { describe, expect, it } from 'vitest';
import { buildLauncherConfigExample } from './launcherConfig';

const TOKEN = 'mmt_launcher-secret';

describe('launcher.tomlの例', () => {
  it('起動に要るapi_url・token_file・state_directory・poll_secondsだけを書き、registryは任意として残す', () => {
    const config = buildLauncherConfigExample({
      apiUrl: 'https://tracking.example.org',
      launcherName: 'main',
    });
    expect(config).toContain('api_url = "https://tracking.example.org"\n');
    expect(config).toContain('token_file = "/run/secrets/mado-tracking-launcher/launcher.token"\n');
    expect(config).toContain('state_directory = "/var/lib/mado-tracking-launcher"\n');
    expect(config).toContain('poll_seconds = 10\n');
    expect(config).toContain('# registry_secret_file = ');
    // The old per-Project and per-site tables are gone: the launcher reads them from the Web.
    expect(config).not.toMatch(/\[\[(projects|sites)\]\]|launcher_id/);
    expect(config.endsWith('\n')).toBe(true);
  });

  it('tokenは例に書かず、token_fileに置く', () => {
    expect(buildLauncherConfigExample({ apiUrl: 'http://127.0.0.1:5182', launcherName: TOKEN })).not.toMatch(
      /^(?!#).*mmt_launcher-secret/m,
    );
  });

  it('名前の改行はコメントを壊さず、URLの引用符とbackslashはTOMLの文字列として逃がす', () => {
    const config = buildLauncherConfigExample({
      apiUrl: 'https://tracking.example.org/"x\\',
      launcherName: 'lab\napi_url = "evil"',
    });
    expect(config).toContain('api_url = "https://tracking.example.org/\\"x\\\\"\n');
    expect(config.split('\n').filter((line) => line.startsWith('api_url'))).toHaveLength(1);
  });
});
