import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import type { Hook, HookExecution } from '@mmt/contracts';
import { HookExecutionsTable } from './HookExecutionsTable';

const execution: HookExecution = {
  id: 'execution-1',
  projectId: 'project',
  hookId: 'hook-1',
  status: 'queued',
  subjectKind: 'run',
  subjectId: 'run-source-0001',
  reason: null,
  error: null,
  jobId: 'job-0001',
  arrayGroupId: null,
  runId: 'run-started-0001',
  waitingRunId: null,
  checkpointId: null,
  requestedBy: null,
  jobStatus: 'running',
  createdAt: '2026-10-09T00:00:00Z',
  updatedAt: '2026-10-09T00:00:00Z',
};
const hooks = [{ id: 'hook-1', name: 'Evaluate checkpoints' }] as Hook[];

const render = (executions: HookExecution[], showHook = true) =>
  renderToStaticMarkup(
    <MemoryRouter>
      <HookExecutionsTable executions={executions} hooks={hooks} projectId="project" showHook={showHook} />
    </MemoryRouter>,
  );

describe('フックの実行履歴', () => {
  it('起動したJobとRun、きっかけのRunへのリンクと、フックの名前を表示する', () => {
    const html = render([execution]);
    expect(html).toContain('Jobを登録');
    expect(html).toContain('Evaluate checkpoints');
    expect(html).toContain('href="/projects/project/runs/run-source-0001"');
    expect(html).toContain('href="/projects/project/jobs?job=job-0001"');
    expect(html).toContain('href="/projects/project/runs/run-started-0001"');
  });

  it('起動しなかった実行は理由を日本語で表示し、コードのまま出さない', () => {
    const html = render([
      { ...execution, status: 'skipped', reason: 'already_running', jobId: null, runId: null, jobStatus: null },
    ]);
    expect(html).toContain('起動せず（前のJobが終わっていない）');
    expect(html).not.toContain('already_running');
  });

  it('1つのフックの履歴ではフックの列を出さず、arrayの起動はJobsのarrayへつなぐ', () => {
    const html = render(
      [{ ...execution, subjectKind: 'array_group', subjectId: 'array-0001', arrayGroupId: 'array-0002' }],
      false,
    );
    expect(html).not.toContain('Evaluate checkpoints');
    expect(html).toContain('href="/projects/project/jobs?array=array-0001"');
    expect(html).toContain('href="/projects/project/jobs?array=array-0002"');
  });
});
