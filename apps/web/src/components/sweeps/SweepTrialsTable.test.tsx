import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import type { SweepObjective, SweepTrial } from '@mmt/contracts';
import { ResponsiveTableView } from '../ResponsiveTable';
import { sweepTrialColumns } from './SweepTrialsTable';
import { text } from '../../i18n/catalog';

const objective: SweepObjective = { metric: 'val_loss', goal: 'minimize', aggregation: 'last' };
const trial = (trialIndex: number, objectiveValue: number | null): SweepTrial => ({
  id: `trial-${trialIndex}`,
  sweepId: 'sweep',
  trialIndex,
  parameters: { lr: 0.05, batch_size: 16 },
  runId: `run-${trialIndex}`,
  jobId: `job-${trialIndex}`,
  state: 'finished',
  objectiveValue,
  objectiveStep: 5,
  stopReason: null,
  runStatus: 'finished',
  jobStatus: 'finished',
  jobCancelRequested: false,
  createdAt: '2026-10-08T00:00:00Z',
  endedAt: '2026-10-08T00:01:00Z',
});
const trials = [trial(0, 0.33), trial(1, 0.018)];

function render(isNarrow: boolean) {
  return renderToStaticMarkup(
    <MemoryRouter>
      <ResponsiveTableView
        columns={sweepTrialColumns({ projectId: 'project', trials, objective, bestTrialId: 'trial-1' })}
        rows={trials}
        rowKey={(row) => row.id}
        isNarrow={isNarrow}
      />
    </MemoryRouter>,
  );
}
const headerTexts = (html: string) =>
  [...html.matchAll(/<th[^>]*>(.*?)<\/th>/g)].map((match) => match[1]!.replace(/<[^>]+>/g, ''));

describe('Sweepの試行表の幅による切り替え', () => {
  it('広い幅では、parameter・Run・Jobを含む全ての列を並べる', () => {
    const html = render(false);
    expect(headerTexts(html)).toEqual([
      text.sweepTrialIndex,
      'batch_size',
      'lr',
      `${text.sweepObjectiveValue}（val_loss）`,
      text.sweepTrialState,
      text.sweepTrialRun,
      text.sweepTrialJob,
    ]);
    expect(html).toContain('href="/projects/project/runs/run-1"');
  });

  it('狭い幅では、試行番号・目的値・状態だけを行に残し、残りは行を開くボタンの先に回す', () => {
    const html = render(true);
    expect(headerTexts(html)).toEqual([
      text.sweepTrialIndex,
      `${text.sweepObjectiveValue}（val_loss）`,
      text.sweepTrialState,
      text.showRowDetails,
    ]);
    // Rows start closed: the Run link is reached by opening the row.
    expect(html).not.toContain('href="/projects/project/runs/run-1"');
    expect(html.match(/aria-expanded="false"/g)).toHaveLength(trials.length);
  });

  it('最良の試行は、狭い幅でも残る目的値の欄で示す', () => {
    const html = render(true);
    expect(html.match(new RegExp(text.sweepBestTrial, 'g'))).toHaveLength(1);
  });
});
