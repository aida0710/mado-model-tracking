import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import type { Hook, JobListItem } from '@mmt/contracts';
import { JobsTable } from './JobsTable';
import { ManualSubmissionNotice } from './ManualSubmissionNotice';
import { computeTarget, queuedJob, siteTarget } from '../../tests/fixtures/execution';

const listItem = (overrides: Partial<JobListItem>): JobListItem => ({
  ...queuedJob,
  runName: 'Generate speech',
  runKind: 'processing',
  taskId: null,
  taskName: null,
  sweepEarlyStopped: false,
  ...overrides,
});
const siteJob = listItem({
  id: 'site-job-0001',
  targetId: siteTarget.id,
  status: 'claimed',
  phase: 'submitted',
  gpuCount: 4,
  schedulerJobId: '12345.pbs',
  runnerHost: null,
  arrayGroupId: 'array-0001',
  arrayIndex: 3,
  arraySize: 64,
  parentJobId: 'driver-job-0001',
  hookId: 'hook-0001',
});
const hooks = [{ id: 'hook-0001', name: 'Shard generation' }] as Hook[];

function render(jobs: JobListItem[]) {
  return renderToStaticMarkup(
    <MemoryRouter>
      <JobsTable
        jobs={jobs}
        targets={[computeTarget, siteTarget]}
        hooks={hooks}
        projectId="project"
        selectedId=""
        canEdit
        resumedRunIds={undefined}
        onSelectJob={() => undefined}
        onSelectArray={() => undefined}
        onAction={() => undefined}
      />
    </MemoryRouter>,
  );
}

describe('Jobsの一覧', () => {
  it('siteのJobに段階、スケジューラのジョブID、GPU数、arrayの番号、親Jobとフックを表示する', () => {
    const html = render([siteJob]);
    expect(html).toContain('待ち行列');
    expect(html).toContain('12345.pbs');
    expect(html).toContain('GPU ×4');
    expect(html).toContain('3 / 64');
    expect(html).toContain('driver-j');
    expect(html).toContain('href="/projects/project/hooks?hook=hook-0001"');
    expect(html).toContain('Shard generation');
  });

  it('時間切れで終わったJobには終了の理由を、手動投入待ちのJobにはその段階を示す', () => {
    const html = render([
      listItem({ id: 'ended', status: 'failed', phase: 'running', endReason: 'timed_out' }),
      listItem({ id: 'manual', targetId: siteTarget.id, phase: 'waiting_manual' }),
    ]);
    expect(html).toContain('時間切れ');
    expect(html).toContain('手動投入待ち');
    expect(html).not.toContain('>実行中<');
  });

  it('sshのJobはGPU IDを表示し、siteの欄は空にする', () => {
    const html = render([listItem({ id: 'ssh', gpuIds: ['0', '1'], gpuCount: 2 })]);
    expect(html).toContain('0, 1');
    expect(html).not.toContain('GPU ×');
    expect(html).not.toContain('待ち行列');
  });

  it('手動投入を待つsiteごとに、本人が実行するコマンドを表示する', () => {
    const html = renderToStaticMarkup(
      <ManualSubmissionNotice
        groups={[
          { targetId: 'site', targetName: 'Miyabi', waitingJobs: 2, ownership: { kind: 'global' } },
        ]}
      />,
    );
    expect(html).toContain('Miyabi: 2件');
    expect(html).toContain('mado-tracking submit --site site');
    // The hint mentions an owner's --all; a site one does not own gets no such command.
    expect(html).not.toContain('--all</code>');
    expect(renderToStaticMarkup(<ManualSubmissionNotice groups={[]} />)).toBe('');
  });
});
