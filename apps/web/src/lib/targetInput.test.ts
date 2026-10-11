import { describe, expect, it } from 'vitest';
import type { ComputeTargetDetails } from '@mmt/contracts';
import { computeTargetDetails, siteTarget } from '../../tests/fixtures/execution';
import {
  automaticSiteSettings,
  globalSiteDetails,
  ownedSiteDetails,
} from '../../tests/fixtures/siteComputers';
import { findJobShellTemplate } from './jobShellTemplates';
import {
  BYTES_PER_GIB,
  buildTargetCreate,
  buildTargetInput,
  newTargetFormValues,
  targetFormValues,
  updateTargetValues,
} from './targetInput';

// The manual site of the fixtures as its owner edits it.
const manualSite: ComputeTargetDetails = {
  ...siteTarget,
  ownerUserId: 'alice',
  ownerName: 'Alice',
  site: ownedSiteDetails.site,
  siteAccountMode: 'personal',
};
const siteValues = {
  ...targetFormValues(manualSite),
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

  it('site以外では手動投入・array・待ち行列の上限を既定値で送り、siteの設定を付けない', () => {
    const values = {
      ...targetFormValues(computeTargetDetails),
      submissionMode: 'manual',
      supportsArray: 'true',
      queueTimeout: '01:00:00',
      cpuArch: 'arm64',
    };
    const input = buildTargetInput(values);
    expect(input).toMatchObject({
      executor: 'ssh',
      host: 'worker.invalid',
      gpuIds: ['0', '1'],
      runtimeKinds: ['python', 'docker'],
      submissionMode: 'automatic',
      supportsArray: false,
      queueTimeoutSeconds: null,
      cpuArch: 'arm64',
    });
    expect(input).not.toHaveProperty('site');
  });

  it('編集ではGiBを変えない限り、APIで設定したbytes単位のcache上限を保つ', () => {
    const target = { ...computeTargetDetails, datasetCacheMaxBytes: 1.5 * BYTES_PER_GIB };
    const values = targetFormValues(target);
    expect(buildTargetInput(values, target).datasetCacheMaxBytes).toBe(1.5 * BYTES_PER_GIB);
    expect(buildTargetInput({ ...values, datasetCacheMaxGiB: '4' }, target).datasetCacheMaxBytes).toBe(
      4 * BYTES_PER_GIB,
    );
  });

  it('sshのtargetをsiteへ切り替えるときは、持っていたコンテナのRuntimeを引き継ぐ', () => {
    expect(targetFormValues(computeTargetDetails).siteRuntimeKinds).toEqual(['docker']);
    expect(
      targetFormValues({ ...computeTargetDetails, runtimeKinds: ['python'] }).siteRuntimeKinds,
    ).toEqual(['apptainer']);
  });
});

describe('siteの全体設定', () => {
  it('保存済みの自動投入のsiteは、編集しなければ同じ全体設定を送る', () => {
    const values = targetFormValues(globalSiteDetails);
    // The job shell is not a setting the dialog saves; it gets a new version on its own.
    expect(buildTargetInput(values, globalSiteDetails).site).toEqual({
      ...automaticSiteSettings,
      jobShell: undefined,
    });
  });

  it('手動投入のsiteにはlauncher・接続先・共用アカウントが無く、本人のアカウントで投入する', () => {
    const values = {
      ...targetFormValues(globalSiteDetails),
      submissionMode: 'manual',
      accountMode: 'shared',
      sharedAccount: 'mmt',
    };
    expect(buildTargetInput(values).site).toMatchObject({
      launcherId: null,
      connection: null,
      accountMode: 'personal',
      sharedAccount: '',
    });
  });

  it('自動投入はlauncherを選ばなければ送らない（APIはsite_settings_invalidで拒む）', () => {
    const values = { ...targetFormValues(globalSiteDetails), launcherId: '' };
    expect(() => buildTargetInput(values)).toThrow('ランチャー');
  });
});

describe('コンピュータの追加', () => {
  const researcher = { canAddSshOrLocal: false };
  const administrator = { canAddSshOrLocal: true };

  it('研究者はsiteから、全体管理者はssh targetから始め、どちらも既定はPrivate', () => {
    expect(newTargetFormValues(researcher)).toMatchObject({ executor: 'site', visibility: 'private' });
    expect(newTargetFormValues(administrator)).toMatchObject({ executor: 'ssh', visibility: 'private' });
  });

  it('siteは選んだ公開範囲と最初のjob shellを付けて追加する', () => {
    const values = {
      ...newTargetFormValues(researcher),
      name: 'Lab server',
      submissionMode: 'manual',
      visibility: 'public',
      jobShell: '#!/bin/sh\nexec "$MMT_RUNNER" "$MMT_SPEC_DIR"\n',
    };
    expect(buildTargetCreate(values)).toMatchObject({
      executor: 'site',
      visibility: 'public',
      jobShell: '#!/bin/sh\nexec "$MMT_RUNNER" "$MMT_SPEC_DIR"\n',
      site: { connection: null, accountMode: 'personal' },
    });
  });

  it('公開範囲はPublicかPrivateだけを送る', () => {
    const values = { ...newTargetFormValues(researcher), name: 'PC', jobShell: '#!/bin/sh\n' };
    expect(() => buildTargetCreate({ ...values, visibility: 'shared' })).toThrow();
  });

  it('job shellの無いsiteは追加しない', () => {
    const values = { ...newTargetFormValues(researcher), name: 'PC', submissionMode: 'manual' };
    expect(() => buildTargetCreate({ ...values, jobShell: '  \n' })).toThrow('job shell');
  });

  it('ssh targetの追加にはsiteの設定・job shellを付けない', () => {
    const created = buildTargetCreate({
      ...newTargetFormValues(administrator),
      name: 'GPU',
      host: 'gpu.invalid',
      username: 'mmt',
      sshKeyPath: '/keys/id',
      knownHostsPath: '/keys/known_hosts',
      workDirectory: '/work',
      jobShell: '#!/bin/sh\n',
    });
    expect(created).toMatchObject({ executor: 'ssh', visibility: 'private' });
    expect(created).not.toHaveProperty('site');
    expect(created).not.toHaveProperty('jobShell');
  });

  it('編集では今の公開範囲から始め、変えた公開範囲を送る', () => {
    const values = targetFormValues(ownedSiteDetails);
    expect(values.visibility).toBe('public');
    expect(buildTargetInput({ ...values, visibility: 'private' }, ownedSiteDetails).visibility).toBe(
      'private',
    );
  });
});

describe('job shellの雛形', () => {
  const start = {
    ...newTargetFormValues({ canAddSshOrLocal: false }),
    name: 'Cluster',
    siteRuntimeKinds: ['docker'],
  };

  it('雛形を選ぶと内容・取消コマンド・array・GPUの渡し方・Runtimeが入り、ほかはそのまま', () => {
    const next = updateTargetValues(start, { ...start, jobShellTemplate: 'slurm' });
    expect(next).toMatchObject({
      name: 'Cluster',
      jobShell: findJobShellTemplate('slurm')?.content,
      cancelCommand: 'scancel "$MMT_SCHEDULER_JOB_ID"',
      supportsArray: 'true',
      gpuAssignment: 'scheduler',
      siteRuntimeKinds: ['apptainer'],
    });
  });

  it('スケジューラの無い雛形は取消コマンドを空にし、arrayを切ってrunnerにGPUを選ばせる', () => {
    const next = updateTargetValues(start, { ...start, jobShellTemplate: 'direct-docker' });
    expect(next).toMatchObject({
      cancelCommand: '',
      supportsArray: 'false',
      gpuAssignment: 'lease',
      siteRuntimeKinds: ['docker'],
    });
  });

  it('雛形を選んだ後に書き換えた内容は、ほかの項目を変えても雛形に戻らない', () => {
    const chosen = updateTargetValues(start, { ...start, jobShellTemplate: 'pbs' });
    const edited = { ...chosen, jobShell: '#!/bin/sh\n# edited\n' };
    expect(updateTargetValues(edited, { ...edited, name: 'ABCI' }).jobShell).toBe('#!/bin/sh\n# edited\n');
    expect(updateTargetValues(edited, { ...edited, jobShellTemplate: '' }).jobShell).toBe(
      '#!/bin/sh\n# edited\n',
    );
  });
});
