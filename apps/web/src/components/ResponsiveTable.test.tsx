import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ResponsiveTable, ResponsiveTableView, type ResponsiveTableColumn } from './ResponsiveTable';
import { text } from '../i18n/catalog';

interface Member {
  id: string;
  name: string;
  email: string;
}

const members: Member[] = [
  { id: 'm1', name: 'Researcher', email: 'researcher@example.test' },
  { id: 'm2', name: 'Reviewer', email: 'reviewer@example.test' },
];
const columns: ResponsiveTableColumn<Member>[] = [
  { key: 'name', priority: 'primary', header: 'Name', render: (member) => member.name },
  { key: 'email', priority: 'secondary', header: 'Email', render: (member) => member.email },
];

function renderView(narrow: boolean, openKeys: string[] = []) {
  return renderToStaticMarkup(
    <ResponsiveTableView
      columns={columns}
      rows={members}
      rowKey={(member) => member.id}
      narrow={narrow}
      openKeys={new Set(openKeys)}
      onToggleRow={() => {}}
    />,
  );
}

describe('ResponsiveTable', () => {
  it('広い幅ではすべての列を見出しとセルに出し、行を開くボタンを出さない', () => {
    const html = renderView(false);
    expect(html).toContain('<th scope="col">Email</th>');
    expect(html).toContain('researcher@example.test');
    expect(html).not.toContain('aria-expanded');
  });

  it('狭い幅では secondary の列を見出しから外し、閉じた行には値を出さない', () => {
    const html = renderView(true);
    expect(html).not.toContain('<th scope="col">Email</th>');
    expect(html).not.toContain('researcher@example.test');
    expect(html.match(/aria-expanded="false"/g)).toHaveLength(2);
    expect(html).toContain(`aria-label="${text.showRowDetails}"`);
  });

  it('狭い幅で開いた行だけが secondary の列を見出しと値の組で出す', () => {
    const html = renderView(true, ['m2']);
    expect(html).toContain('<dt>Email</dt><dd>reviewer@example.test</dd>');
    expect(html).not.toContain('researcher@example.test');
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain(`aria-label="${text.hideRowDetails}"`);
  });

  it('secondary の列が無い表は狭い幅でも開くボタンを出さない', () => {
    const html = renderToStaticMarkup(
      <ResponsiveTableView
        columns={columns.filter((column) => column.priority === 'primary')}
        rows={members}
        rowKey={(member) => member.id}
        narrow
        openKeys={new Set()}
        onToggleRow={() => {}}
      />,
    );
    expect(html).not.toContain('aria-expanded');
  });

  it('行が無いときは表の代わりに空の案内を出す', () => {
    const html = renderToStaticMarkup(
      <ResponsiveTable columns={columns} rows={[]} rowKey={(member) => member.id} empty="まだありません" />,
    );
    expect(html).toContain('まだありません');
    expect(html).not.toContain('<table');
  });
});
