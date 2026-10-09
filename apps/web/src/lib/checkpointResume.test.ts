import { describe, expect, it } from 'vitest';
import type { Job, RunStatus } from '@mmt/contracts';
import {
  canResumeFromCheckpoint,
  collectResumedRunIds,
  findRunJob,
  getCheckpointArtifactFileName,
  getResumeCheckpointRecord,
} from './checkpointResume';
import { queuedJob } from '../../tests/fixtures/execution';

function job(id: string, runId: string): Job {
  return { ...queuedJob, id, runId, status: 'failed', exitCode: 1 };
}

describe('checkpointからの再開の可否', () => {
  it('失敗・停止したRunにJobがありeditor以上なら再開できる', () => {
    for (const status of ['failed', 'canceled'] as const)
      expect(
        canResumeFromCheckpoint({ run: { status }, job: { status }, canEdit: true }),
      ).toBe(true);
  });

  it('完了・実行中のRunは再開の対象にしない', () => {
    const notResumable: RunStatus[] = ['queued', 'running', 'finished'];
    for (const status of notResumable)
      expect(
        canResumeFromCheckpoint({ run: { status }, job: { status: 'failed' }, canEdit: true }),
      ).toBe(false);
  });

  it('Jobの無いRunとviewerには再開を出さない', () => {
    expect(
      canResumeFromCheckpoint({ run: { status: 'failed' }, job: undefined, canEdit: true }),
    ).toBe(false);
    expect(
      canResumeFromCheckpoint({
        run: { status: 'failed' },
        job: { status: 'failed' },
        canEdit: false,
      }),
    ).toBe(false);
  });

  it('Jobがまだ終端でなければ再開を出さない', () => {
    expect(
      canResumeFromCheckpoint({ run: { status: 'failed' }, job: { status: 'running' }, canEdit: true }),
    ).toBe(false);
  });
});

describe('RunのJobの特定', () => {
  it('新しい順の一覧から同じRunの最初のJobを返す', () => {
    const jobs = [job('newer', 'run-a'), job('other', 'run-b'), job('older', 'run-a')];
    expect(findRunJob(jobs, 'run-a')?.id).toBe('newer');
    expect(findRunJob(jobs, 'run-c')).toBeUndefined();
  });
});

describe('再開Runの記録の読み取り', () => {
  it('environment.resumeから再開元のcheckpointとstepを読む', () => {
    const resume = { checkpointId: 'checkpoint', sourceRunId: 'source', step: 1200 };
    expect(getResumeCheckpointRecord({ environment: { resume, python: '3.12' } })).toEqual(resume);
  });

  it('記録が無い・形が契約と違うときは再開Runとして扱わない', () => {
    expect(getResumeCheckpointRecord({ environment: {} })).toBeNull();
    expect(getResumeCheckpointRecord({ environment: { resume: 'checkpoint' } })).toBeNull();
    expect(
      getResumeCheckpointRecord({
        environment: { resume: { checkpointId: 'checkpoint', sourceRunId: 'source', step: '12' } },
      }),
    ).toBeNull();
    expect(
      getResumeCheckpointRecord({
        environment: { resume: { checkpointId: 'checkpoint', step: 12 } },
      }),
    ).toBeNull();
  });

  it('Run一覧のsummaryからcheckpointを指定したRunだけを集める', () => {
    const runs = [
      { id: 'resumed', resumeCheckpointId: 'checkpoint' },
      { id: 'scratch', resumeCheckpointId: null },
      { id: 'older-api' },
    ];
    expect([...collectResumedRunIds(runs)]).toEqual(['resumed']);
  });
});

describe('checkpointのArtifactのダウンロード名', () => {
  it('フォルダを除いたファイル名にする', () => {
    expect(getCheckpointArtifactFileName({ path: 'checkpoints/step-100.tar' })).toBe('step-100.tar');
    expect(getCheckpointArtifactFileName({ path: 'model.safetensors' })).toBe('model.safetensors');
  });
});
