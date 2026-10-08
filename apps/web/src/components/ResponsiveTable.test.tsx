import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ResponsiveTableView, type ResponsiveTableColumn } from './ResponsiveTable';
import { text } from '../i18n/catalog';

interface Model {
  id: string;
  name: string;
  owner: string;
  createdAt: string;
}

const rows: Model[] = [
  { id: 'm1', name: 'asr-small', owner: 'aida', createdAt: '2026-10-01' },
  { id: 'm2', name: 'asr-large', owner: 'mado', createdAt: '2026-10-02' },
];
const columns: ResponsiveTableColumn<Model>[] = [
  { key: 'name', header: '名前', render: (row) => row.name, priority: 'primary' },
  { key: 'owner', header: '作成者', render: (row) => row.owner, priority: 'secondary' },
  { key: 'created', header: '作成日', render: (row) => row.createdAt, priority: 'secondary' },
];

const render = (isNarrow: boolean, tableColumns = columns) =>
  renderToStaticMarkup(
    <ResponsiveTableView
      columns={tableColumns}
      rows={rows}
      rowKey={(row) => row.id}
      isNarrow={isNarrow}
    />,
  );
const headers = (markup: string) =>
  [...markup.matchAll(/<th(?:\s[^>]*)?>(.*?)<\/th>/g)].map((match) => match[1]);

describe('ResponsiveTable', () => {
  it('広い幅では全列を見出しに並べ、行を開くボタンを出さない', () => {
    const markup = render(false);
    expect(headers(markup)).toEqual(['名前', '作成者', '作成日']);
    expect(markup).not.toContain('aria-expanded');
    expect(markup).toContain('aida');
  });

  it('狭い幅では primary 列だけを出し、各行に閉じた状態の開くボタンを付ける', () => {
    const markup = render(true);
    expect(headers(markup)).toEqual([
      '名前',
      `<span class="sr-only">${text.showRowDetails}</span>`,
    ]);
    expect(markup.match(/aria-expanded="false"/g)).toHaveLength(rows.length);
    // secondary の値は行を開くまで出ない。
    expect(markup).not.toContain('aida');
    expect(markup).not.toContain('responsive-table-details');
  });

  it('狭い幅でも secondary 列が無い表には開くボタンを付けない', () => {
    const markup = render(true, columns.slice(0, 1));
    expect(headers(markup)).toEqual(['名前']);
    expect(markup).not.toContain('aria-expanded');
  });

  it('行が無いときは表の代わりに空の案内を出す', () => {
    const markup = renderToStaticMarkup(
      <ResponsiveTableView
        columns={columns}
        rows={[]}
        rowKey={(row) => row.id}
        isNarrow={false}
        empty="モデルはまだありません"
      />,
    );
    expect(markup).not.toContain('<table');
    expect(markup).toContain('モデルはまだありません');
  });
});
