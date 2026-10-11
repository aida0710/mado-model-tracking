import { describe, expect, it } from 'vitest';
import { globalSiteDetails } from '../../tests/fixtures/siteComputers';
import { buildSiteSettingsInput, siteSettingsFormValues } from './siteSettingsInput';

const automatic = { ...siteSettingsFormValues(globalSiteDetails.site), submissionMode: 'automatic' };
const manual = { ...siteSettingsFormValues(null), submissionMode: 'manual' };

describe('siteの全体設定の入力', () => {
  it('新しいsiteはAPIの既定値（port 22・python3・1回10件・猶予10秒・出力1万件）から始める', () => {
    expect(siteSettingsFormValues(null)).toMatchObject({
      launcherId: '',
      sitePort: '22',
      accountMode: 'personal',
      runnerPython: 'python3',
      gpuAssignment: 'scheduler',
      maxActiveSubmissions: '10',
      cancelGraceSeconds: '10',
      maxOutputFiles: '10000',
    });
  });

  it('手動投入のsiteは接続先を持たず、取消コマンドやrunnerのURLが空ならnullで送る', () => {
    expect(buildSiteSettingsInput(manual)).toEqual({
      launcherId: null,
      connection: null,
      accountMode: 'personal',
      sharedAccount: '',
      workDirectory: '',
      runnerPython: 'python3',
      runnerApiUrl: null,
      cancelCommand: null,
      gpuAssignment: 'scheduler',
      leaseGpuIds: [],
      variables: {},
      maxActiveSubmissions: 10,
      cancelGraceSeconds: 10,
      maxOutputFiles: 10_000,
    });
  });

  it('経由するホストは1行に1つで、known_hostsは末尾を改行1つにそろえる', () => {
    const settings = buildSiteSettingsInput({
      ...automatic,
      siteJumpHosts: 'alice@gateway.invalid:2222\n\n  bastion.invalid  \n',
      siteKnownHosts: '\nlogin.invalid ssh-ed25519 AAAA\n\n',
    });
    expect(settings.connection).toEqual({
      host: 'login.example.invalid',
      port: 2222,
      jumpHosts: ['alice@gateway.invalid:2222', 'bastion.invalid'],
      knownHosts: 'login.invalid ssh-ed25519 AAAA\n',
    });
  });

  it('自動投入では接続先のhostとknown_hostsが要り、sshのoptionに見えるhostは拒否する', () => {
    expect(() => buildSiteSettingsInput({ ...automatic, siteHost: ' ' })).toThrow('host');
    expect(() => buildSiteSettingsInput({ ...automatic, siteHost: '-oProxyCommand=x' })).toThrow('host');
    expect(() => buildSiteSettingsInput({ ...automatic, siteHost: 'login node' })).toThrow('host');
    expect(() => buildSiteSettingsInput({ ...automatic, siteJumpHosts: '-J evil' })).toThrow('-J evil');
    expect(() => buildSiteSettingsInput({ ...automatic, siteKnownHosts: '' })).toThrow('known_hosts');
    expect(() => buildSiteSettingsInput({ ...automatic, sitePort: '70000' })).toThrow('1〜65535');
  });

  it('経由するホストは8個まで、known_hostsは64 KiBまで', () => {
    const nine = Array.from({ length: 9 }, (_, index) => `hop${index}.invalid`).join('\n');
    expect(() => buildSiteSettingsInput({ ...automatic, siteJumpHosts: nine })).toThrow('8個');
    const large = `login.invalid ssh-ed25519 ${'A'.repeat(64 * 1024)}`;
    expect(() => buildSiteSettingsInput({ ...automatic, siteKnownHosts: large })).toThrow('64 KiB');
  });

  it('known_hostsの行は「ホスト 鍵の種類 鍵」で、#の行は注釈として読み飛ばす', () => {
    expect(() =>
      buildSiteSettingsInput({ ...automatic, siteKnownHosts: 'login.invalid ssh-ed25519' }),
    ).toThrow('ホスト 鍵の種類 鍵');
    const withComment = '# login.invalid:22 SSH-2.0-OpenSSH_9.6\nlogin.invalid ssh-ed25519 AAAA';
    expect(buildSiteSettingsInput({ ...automatic, siteKnownHosts: withComment }).connection?.knownHosts).toBe(
      `${withComment}\n`,
    );
  });

  it('自動投入には投入するlauncherが要る', () => {
    expect(() => buildSiteSettingsInput({ ...automatic, launcherId: '' })).toThrow('ランチャー');
    expect(buildSiteSettingsInput({ ...manual, launcherId: 'launcher' }).launcherId).toBeNull();
  });

  it('共用アカウントのsiteはアカウント名と作業ディレクトリが要り、本人のアカウントのsiteでは共用アカウントを送らない', () => {
    const shared = { ...automatic, accountMode: 'shared' };
    expect(() => buildSiteSettingsInput({ ...shared, sharedAccount: '' })).toThrow('共用アカウント名');
    expect(() => buildSiteSettingsInput({ ...shared, sharedAccount: 'mmt user' })).toThrow('アカウント名');
    expect(buildSiteSettingsInput({ ...shared, sharedAccount: ' mmt ' }).sharedAccount).toBe('mmt');
    expect(() =>
      buildSiteSettingsInput({ ...shared, sharedAccount: 'mmt', siteWorkDirectory: '' }),
    ).toThrow('作業ディレクトリ');
    expect(
      buildSiteSettingsInput({ ...automatic, accountMode: 'personal', sharedAccount: 'mmt' }).sharedAccount,
    ).toBe('');
  });

  it('アカウント名は数字で始まってもよく、64文字を超えると拒否する', () => {
    const shared = { ...automatic, accountMode: 'shared' };
    expect(buildSiteSettingsInput({ ...shared, sharedAccount: '0mmt' }).sharedAccount).toBe('0mmt');
    expect(() => buildSiteSettingsInput({ ...shared, sharedAccount: 'a'.repeat(65) })).toThrow(
      'アカウント名',
    );
  });

  it('作業ディレクトリとrunnerのPythonは、job shellが受け付ける文字だけのパス', () => {
    expect(() => buildSiteSettingsInput({ ...manual, siteWorkDirectory: 'mmt' })).toThrow('絶対パス');
    expect(() => buildSiteSettingsInput({ ...manual, siteWorkDirectory: '/data/my mmt' })).toThrow(
      '絶対パス',
    );
    expect(buildSiteSettingsInput({ ...manual, siteWorkDirectory: ' /data/mmt ' }).workDirectory).toBe(
      '/data/mmt',
    );
    expect(() => buildSiteSettingsInput({ ...manual, runnerPython: 'python3 -I' })).toThrow('runnerのPython');
    expect(() => buildSiteSettingsInput({ ...manual, runnerPython: ' ' })).toThrow();
  });

  it('runnerから見たAPIのURLはhttp(s)だけ', () => {
    expect(() => buildSiteSettingsInput({ ...manual, runnerApiUrl: 'ftp://runner.invalid' })).toThrow('URL');
    expect(() =>
      buildSiteSettingsInput({ ...manual, runnerApiUrl: 'https://user:secret@runner.invalid' }),
    ).toThrow('URL');
    expect(buildSiteSettingsInput({ ...manual, runnerApiUrl: 'https://runner.invalid' }).runnerApiUrl).toBe(
      'https://runner.invalid',
    );
  });

  it('runnerが選ぶGPUはスケジューラの無いホスト（lease）でだけ送る', () => {
    const gpus = { ...manual, leaseGpuIds: '0\n1\n' };
    expect(buildSiteSettingsInput({ ...gpus, gpuAssignment: 'lease' }).leaseGpuIds).toEqual(['0', '1']);
    expect(buildSiteSettingsInput({ ...gpus, gpuAssignment: 'scheduler' }).leaseGpuIds).toEqual([]);
  });

  it('1回に受け取る数・取消の猶予・出力の上限は範囲の外を拒否する', () => {
    expect(() => buildSiteSettingsInput({ ...manual, maxActiveSubmissions: '51' })).toThrow('1〜50');
    expect(() => buildSiteSettingsInput({ ...manual, cancelGraceSeconds: '0' })).toThrow('1〜3600');
    expect(() => buildSiteSettingsInput({ ...manual, maxOutputFiles: '1000001' })).toThrow('1〜1000000');
    expect(() => buildSiteSettingsInput({ ...manual, maxActiveSubmissions: '' })).toThrow();
  });

  it('変数はNAME=VALUEの行からまとめる', () => {
    expect(buildSiteSettingsInput({ ...manual, siteVariables: 'GROUP=gaa50000\nQUEUE=gpu' }).variables).toEqual(
      { GROUP: 'gaa50000', QUEUE: 'gpu' },
    );
  });
});
