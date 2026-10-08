import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { MediaCompareGrid, RunMedia } from '@mmt/contracts';
import { MediaCompareGridView } from './MediaCompareGrid';

function image(runId: string, step: number): RunMedia {
  return {
    id: `${runId}-${step}`,
    runId,
    key: 'samples/spectrogram',
    step,
    kind: 'image',
    artifactId: `artifact-${runId}-${step}`,
    thumbnailArtifactId: null,
    caption: null,
    metadata: {},
    source: 'native',
    path: `media/${step}.png`,
    mimeType: 'image/png',
    size: 10,
    contentUrl: '',
    thumbnailContentUrl: null,
    createdAt: '2026-10-09T00:00:00.000Z',
  };
}

const grid: MediaCompareGrid = {
  key: 'samples/spectrogram',
  steps: [10, 20],
  rows: [
    { runId: 'run-a', cells: [[image('run-a', 10)], null] },
    { runId: 'run-b', cells: [null, [image('run-b', 20)]] },
  ],
};
const runLabels = { 'run-a': '学習 1回目', 'run-b': '学習 2回目' };

describe('MediaCompareGridView', () => {
  it('広い幅では Run を行、step を列にした格子で出す', () => {
    const html = renderToStaticMarkup(
      <MediaCompareGridView projectId="project" grid={grid} runLabels={runLabels} isNarrow={false} />,
    );
    expect(html).toContain('role="grid"');
    expect(html).not.toContain('media-compare-run"');
  });

  it('狭い幅では Run ごとに縦に並べ、各 Run の中に全 step のセルを出す', () => {
    const html = renderToStaticMarkup(
      <MediaCompareGridView projectId="project" grid={grid} runLabels={runLabels} isNarrow />,
    );
    expect(html).not.toContain('role="grid"');
    const sections = html.match(/<section class="media-compare-run" aria-label="[^"]+">/g) ?? [];
    expect(sections).toEqual([
      '<section class="media-compare-run" aria-label="学習 1回目">',
      '<section class="media-compare-run" aria-label="学習 2回目">',
    ]);
    expect(html.match(/class="media-compare-cell/g)).toHaveLength(4);
  });

  it('狭い幅では選んだセルのプレビューを、その Run の並びのすぐ下に出す', () => {
    const html = renderToStaticMarkup(
      <MediaCompareGridView projectId="project" grid={grid} runLabels={runLabels} isNarrow />,
    );
    const firstRun = html.indexOf('aria-label="学習 1回目"');
    const detail = html.indexOf('media-compare-detail');
    const secondRun = html.indexOf('aria-label="学習 2回目"');
    expect(firstRun).toBeLessThan(detail);
    expect(detail).toBeLessThan(secondRun);
    expect(html).toContain('aria-pressed="true"');
  });
});
