import { describe, expect, it } from 'vitest';
import { computeTarget, siteTarget } from '../../tests/fixtures/execution';
import { BYTES_PER_GIB, buildTargetInput, targetFormValues } from './targetInput';

const siteValues = {
  ...targetFormValues(siteTarget),
  // What a person might leave in the SSH fields before switching the executor to site.
  host: 'login.example.invalid',
  username: 'someone',
  sshKeyPath: '/keys/id',
  pythonExecutable: 'python3',
  gpuIds: '0\n1',
  runtimeKinds: ['python', 'docker'],
};

describe('Compute targetの入力', () => {
  it('siteは接続の項目・GPU ID・Pythonを空で送り、投入方式・CPU・array・待ち行列の上限を送る', () => {
    expect(buildTargetInput(siteValues)).toMatchObject({
      executor: 'site',
      host: '',
      port: 22,
      username: '',
      sshKeyPath: '',
      knownHostsPath: '',
      workDirectory: '',
      pythonExecutable: '',
      gpuIds: [],
      datasetTransfer: 'direct',
      runtimeKinds: ['docker', 'apptainer'],
      submissionMode: 'manual',
      cpuArch: 'arm64',
      supportsArray: true,
      queueTimeoutSeconds: 3600,
    });
  });

  it('siteのRuntimeにPythonは選べず、コンテナが1つも無ければ拒否する', () => {
    expect(() => buildTargetInput({ ...siteValues, siteRuntimeKinds: ['python'] })).toThrow();
    expect(() => buildTargetInput({ ...siteValues, siteRuntimeKinds: [] })).toThrow('Docker');
  });

  it('待ち行列の上限は空ならnullで、形の違う値は拒否する', () => {
    expect(buildTargetInput({ ...siteValues, queueTimeout: '' }).queueTimeoutSeconds).toBeNull();
    expect(() => buildTargetInput({ ...siteValues, queueTimeout: '60' })).toThrow();
  });

  it('site以外では手動投入・array・待ち行列の上限を既定値で送る', () => {
    const values = {
      ...targetFormValues(computeTarget),
      submissionMode: 'manual',
      supportsArray: 'true',
      queueTimeout: '01:00:00',
      cpuArch: 'arm64',
    };
    expect(buildTargetInput(values)).toMatchObject({
      executor: 'ssh',
      host: 'worker.invalid',
      gpuIds: ['0', '1'],
      runtimeKinds: ['python', 'docker'],
      submissionMode: 'automatic',
      supportsArray: false,
      queueTimeoutSeconds: null,
      cpuArch: 'arm64',
    });
  });

  it('編集ではGiBを変えない限り、APIで設定したbytes単位のcache上限を保つ', () => {
    const target = { ...computeTarget, datasetCacheMaxBytes: 1.5 * BYTES_PER_GIB };
    const values = targetFormValues(target);
    expect(buildTargetInput(values, target).datasetCacheMaxBytes).toBe(1.5 * BYTES_PER_GIB);
    expect(buildTargetInput({ ...values, datasetCacheMaxGiB: '4' }, target).datasetCacheMaxBytes).toBe(
      4 * BYTES_PER_GIB,
    );
  });

  it('sshのtargetをsiteへ切り替えるときは、持っていたコンテナのRuntimeを引き継ぐ', () => {
    expect(targetFormValues(computeTarget).siteRuntimeKinds).toEqual(['docker']);
    expect(targetFormValues({ ...computeTarget, runtimeKinds: ['python'] }).siteRuntimeKinds).toEqual([
      'apptainer',
    ]);
  });
});
