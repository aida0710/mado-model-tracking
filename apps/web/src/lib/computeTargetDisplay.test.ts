import { describe, expect, it } from 'vitest';
import {
  formatTargetLocation,
  targetCheckHintFor,
  targetCheckItemLabel,
} from './computeTargetDisplay';

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
});
