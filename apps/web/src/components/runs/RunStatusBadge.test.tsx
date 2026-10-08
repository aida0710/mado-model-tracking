import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { RunStatusBadge } from './RunStatusBadge';
import { SWEEP_EARLY_STOPPED_TAG } from '../../lib/sweepRunTags';

describe('RunStatusBadge', () => {
  it('Sweepが打ち切った中止のRunは早期打ち切りと表示する', () => {
    const html = renderToStaticMarkup(<RunStatusBadge run={{ status: 'canceled', tags: { [SWEEP_EARLY_STOPPED_TAG]: 'true' } }} />);
    expect(html).toContain('早期打ち切り');
    expect(html).toContain('status-early-stopped');
  });

  it('人が中止したRunは中止と表示する', () => {
    expect(renderToStaticMarkup(<RunStatusBadge run={{ status: 'canceled', tags: {} }} />)).toContain('中止');
  });

  it('完了したRunは打ち切りのtagがあっても完了と表示する', () => {
    const html = renderToStaticMarkup(<RunStatusBadge run={{ status: 'finished', tags: { [SWEEP_EARLY_STOPPED_TAG]: 'true' } }} />);
    expect(html).toContain('完了');
    expect(html).not.toContain('早期打ち切り');
  });
});
