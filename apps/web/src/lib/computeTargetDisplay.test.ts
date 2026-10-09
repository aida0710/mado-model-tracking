import { describe, expect, it } from 'vitest';
import {
  formatTargetGpus,
  formatTargetLocation,
  targetCheckHintFor,
  targetCheckItemLabel,
  targetChoiceLabel,
} from './computeTargetDisplay';
import { computeTarget, siteTarget } from '../../tests/fixtures/execution';

const sshTarget = { executor: 'ssh', host: 'gpu01', port: 2222, username: 'mmt' } as const;
const localTarget = { executor: 'local', host: '127.0.0.1', port: 22, username: 'local' } as const;

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

  it('siteは接続先を持たないので、サイト側の設定とJobごとのGPU数として表示する', () => {
    expect(formatTargetLocation(siteTarget)).toBe('サイト側の設定');
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

  it('siteの接続確認はworkerではなくlauncherの役目だと説明する', () => {
    expect(targetCheckHintFor('site')).toContain('launcher');
    expect(targetCheckHintFor('site')).toContain('mado-tracking submit');
  });
});
