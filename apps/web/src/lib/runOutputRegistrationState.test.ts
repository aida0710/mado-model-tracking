import { describe, expect, it } from 'vitest';
import type { Run, RunOutputRegistration } from '@mmt/contracts';
import { getRunOutputRegistrationState } from './runOutputRegistrationState';

const setting = { modelId: 'model', createModel: null, artifactPath: 'model' };
const run = (status: Run['status'], outputModelRegistration: Run['outputModelRegistration'] = setting) =>
  ({ status, outputModelRegistration });
const registration = (override: Partial<RunOutputRegistration>): RunOutputRegistration =>
  ({ status: 'registered', modelVersionId: 'version', error: null, reason: null, ...override });

describe('Run詳細の出力モデル登録の表示', () => {
  it('出力設定のあるRunは終端になるまで学習完了後の登録待ちとして表示する', () => {
    expect(getRunOutputRegistrationState(run('running'), null)).toEqual({ kind: 'pending' });
    expect(getRunOutputRegistrationState(run('queued'), undefined)).toEqual({ kind: 'pending' });
    expect(getRunOutputRegistrationState(run('running', null), null)).toEqual({ kind: 'none' });
    expect(getRunOutputRegistrationState(run('failed'), null)).toEqual({ kind: 'none' });
  });
  it('登録済みは登録したバージョンへのリンクを表示する', () => {
    expect(getRunOutputRegistrationState(run('finished'), registration({}))).toEqual({ kind: 'registered', modelVersionId: 'version' });
  });
  it('学習コードが同じModelへ登録した場合は、そのバージョンを使ったことを表示する', () => {
    expect(getRunOutputRegistrationState(run('finished'), registration({ status: 'skipped', reason: 'already_registered_by_run' })))
      .toEqual({ kind: 'skipped', modelVersionId: 'version' });
  });
  it('登録に失敗した場合は理由を表示する', () => {
    expect(getRunOutputRegistrationState(run('finished'), registration({ status: 'failed', modelVersionId: null, error: 'artifact_not_found' })))
      .toEqual({ kind: 'failed', error: 'artifact_not_found' });
  });
});
