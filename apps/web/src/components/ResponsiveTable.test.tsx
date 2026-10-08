import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ResponsiveTableDetails, ResponsiveTableView, type ResponsiveTableColumn } from './ResponsiveTable';
import { responsiveTableText } from '../i18n/responsiveTable';

interface Row {
  id: string;
  path: string;
  run: string;
  size: string;
}

const rows: Row[] = [
  { id: 'a', path: 'audio/a.wav', run: '学習 1回目', size: '25 KiB' },
  { id: 'b', path: 'audio/b.wav', run: '学習 2回目', size: '30 KiB' },
];
const columns: ResponsiveTableColumn<Row>[] = [
  { key: 'path', header: '保存パス', priority: 'primary', render: (row) => row.path },
  { key: 'run', header: 'Run', priority: 'secondary', render: (row) => row.run },
  { key: 'size', header: 'サイズ', priority: 'primary', render: (row) => row.size },
];

describe('ResponsiveTableView', () => {
  it('広い幅ではすべての列を見出しとセルに出し、行を開くボタンを出さない', () => {
    const html = renderToStaticMarkup(
      <ResponsiveTableView columns={columns} rows={rows} rowKey={(row) => row.id} isNarrow={false} />,
    );
    expect(html).toContain('>Run</th>');
    expect(html).toContain('学習 1回目');
    expect(html).not.toContain('aria-expanded');
  });

  it('狭い幅では secondary の列を閉じた行に出さず、各行に閉じた状態の開くボタンを出す', () => {
    const html = renderToStaticMarkup(
      <ResponsiveTableView columns={columns} rows={rows} rowKey={(row) => row.id} isNarrow />,
    );
    expect(html).not.toContain('>Run</th>');
    expect(html).not.toContain('学習 1回目');
    expect(html).toContain('audio/a.wav');
    expect(html).toContain('25 KiB');
    expect(html.match(/aria-expanded="false"/g)).toHaveLength(rows.length);
    expect(html).toContain(`aria-label="${responsiveTableText.responsiveTableShowDetails}"`);
  });

  it('行を開いたときの詳細は secondary の列を見出しと値の組で出す', () => {
    const html = renderToStaticMarkup(
      <table>
        <tbody>
          <ResponsiveTableDetails id="details-a" row={rows[0]!} columns={[columns[1]!]} colSpan={3} />
        </tbody>
      </table>,
    );
    expect(html).toContain('<dt>Run</dt>');
    expect(html).toContain('学習 1回目');
    expect(html).toMatch(/colspan="3"/i);
  });

  it('行が無いときは空の表示を出す', () => {
    const html = renderToStaticMarkup(
      <ResponsiveTableView columns={columns} rows={[]} rowKey={(row) => row.id} empty="ありません" isNarrow />,
    );
    expect(html).toContain('ありません');
    expect(html).not.toContain('<table');
  });
});
