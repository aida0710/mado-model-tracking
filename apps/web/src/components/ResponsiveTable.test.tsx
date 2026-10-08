import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ResponsiveTable, ResponsiveTableLayout, type ResponsiveColumn } from './ResponsiveTable';
import { responsiveText } from '../i18n/responsive';

interface Job {
  id: string;
  target: string;
}
const jobs: Job[] = [{ id: 'job-1', target: 'gpu-host-a' }];
const columns: ResponsiveColumn<Job>[] = [
  { key: 'id', header: 'Job', priority: 'primary', render: (job) => job.id },
  { key: 'target', header: '計算機', priority: 'secondary', render: (job) => job.target },
];

describe('ResponsiveTable', () => {
  it('shows every column and no row toggle on a wide window', () => {
    const markup = renderToStaticMarkup(
      <ResponsiveTableLayout columns={columns} rows={jobs} rowKey={(job) => job.id} isNarrow={false} />,
    );
    expect(markup).toContain('計算機');
    expect(markup).toContain('gpu-host-a');
    expect(markup).not.toContain('aria-expanded');
  });

  it('keeps only primary columns on a narrow window and offers to open the row', () => {
    const markup = renderToStaticMarkup(
      <ResponsiveTableLayout columns={columns} rows={jobs} rowKey={(job) => job.id} isNarrow />,
    );
    expect(markup).toContain('job-1');
    expect(markup).not.toContain('計算機');
    expect(markup).not.toContain('gpu-host-a');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain(`aria-label="${responsiveText.showRowDetails}"`);
  });

  it('needs no row toggle when every column is primary', () => {
    const markup = renderToStaticMarkup(
      <ResponsiveTableLayout
        columns={[columns[0]!]}
        rows={jobs}
        rowKey={(job) => job.id}
        isNarrow
      />,
    );
    expect(markup).not.toContain('aria-expanded');
  });

  it('renders the wide layout where the window width is unknown (server rendering)', () => {
    const markup = renderToStaticMarkup(
      <ResponsiveTable columns={columns} rows={jobs} rowKey={(job) => job.id} />,
    );
    expect(markup).toContain('gpu-host-a');
  });

  it('shows the empty message instead of a table without rows', () => {
    const markup = renderToStaticMarkup(
      <ResponsiveTableLayout columns={columns} rows={[]} rowKey={(job) => job.id} empty="Jobはありません" isNarrow />,
    );
    expect(markup).toContain('Jobはありません');
    expect(markup).not.toContain('<table');
  });
});
