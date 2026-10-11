import { describe, expect, it } from 'vitest';
import {
  formatTargetGpus,
  formatTargetLocation,
  targetCheckHintFor,
  targetCheckItemLabel,
  targetChoiceLabel,
} from './computeTargetDisplay';
import { computeTarget, siteTarget } from '../../tests/fixtures/execution';
import {
  automaticSiteSettings,
  globalSiteDetails,
  ownedSiteDetails,
  publicSiteForUser,
} from '../../tests/fixtures/siteComputers';

const sshTarget = { executor: 'ssh', host: 'gpu01', port: 2222, username: 'mmt', site: null } as const;
const localTarget = {
  executor: 'local',
  host: '127.0.0.1',
  port: 22,
  username: 'local',
  site: null,
} as const;

describe('Compute targetの表示', () => {
  it('SSHのtargetは接続先を表示し、localのtargetはhostが入っていてもSSHの接続先として出さない', () => {
    expect(formatTargetLocation(sshTarget)).toBe('mmt@gpu01:2222');
    expect(formatTargetLocation(localTarget)).toBe('workerのホスト上');
    expect(formatTargetLocation({ ...sshTarget, host: '' })).toBe('—');
  });

  it('localのtargetの接続確認は、SSHではなくコマンドの起動として説明する', () => {
    expect(targetCheckItemLabel('connection', 'local')).toBe('コマンドの起動');
    expect(targetCheckItemLabel('connection', 'ssh')).toBe('SSH接続');
    expect(targetCheckItemLabel('python', 'local')).toBe('Python');
    expect(targetCheckHintFor('local')).not.toContain('SSH');
    expect(targetCheckHintFor('ssh')).toContain('SSH');
  });

  it('siteは設定の接続先を、共用アカウントならそのアカウントを付けて表示する', () => {
    expect(formatTargetLocation(globalSiteDetails)).toBe('login.example.invalid:2222');
    const shared = {
      ...globalSiteDetails,
      site: { ...automaticSiteSettings, accountMode: 'shared' as const, sharedAccount: 'mmt' },
    };
    expect(formatTargetLocation(shared)).toBe('mmt@login.example.invalid:2222');
  });

  it('手動投入のsiteと、設定を見られない人のsiteには接続先を出さない', () => {
    expect(formatTargetLocation(ownedSiteDetails)).toBe('—');
    expect(formatTargetLocation(publicSiteForUser)).toBe('—');
  });

  it('siteのGPUはJobごとの数として表示する', () => {
    expect(formatTargetGpus(siteTarget)).toBe('Jobごとに数を指定');
    expect(formatTargetGpus(computeTarget)).toBe('0, 1');
    expect(formatTargetGpus({ ...computeTarget, gpuIds: [] })).toBe('CPUのみ');
  });

  it('選択肢ではsiteに投入方式を添える', () => {
    expect(targetChoiceLabel(computeTarget)).toBe('Container worker · worker.invalid');
    expect(targetChoiceLabel(siteTarget)).toBe('Supercomputer · Site（手動投入）');
    expect(targetChoiceLabel({ ...siteTarget, submissionMode: 'automatic' })).toBe(
      'Supercomputer · Site（自動投入）',
    );
  });
});
