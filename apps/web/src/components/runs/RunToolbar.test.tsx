import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { RunKind } from '@mmt/contracts';
import { RunToolbar } from './RunToolbar';

const noop = () => {};

function renderToolbar(kinds: RunKind[]) {
  return renderToStaticMarkup(
    <RunToolbar
      searchText=""
      status=""
      kinds={kinds}
      sort="newest"
      metricNames={[]}
      columnNames={[]}
      isColumnVisible={() => false}
      onSearch={noop}
      onStatusChange={noop}
      onKindsChange={noop}
      onSortChange={noop}
      onColumnToggle={noop}
      exportingCsv={false}
      onExportCsv={noop}
    />,
  );
}

describe('Run一覧の実行種別の絞り込み', () => {
  it('保存ビューの実行種別を選択した状態で表示する', () => {
    expect(renderToolbar(['training'])).toMatch(/<option value="training" selected="">/);
  });

  it('APIで保存した複数の種別は1つの選択肢として残し、ほかの種別も選べる', () => {
    const html = renderToolbar(['inference', 'evaluation']);
    expect(html).toMatch(/<option value="inference,evaluation" selected="">[^<]*<\/option>/);
    expect(html).toContain('<option value="training">');
  });
});
