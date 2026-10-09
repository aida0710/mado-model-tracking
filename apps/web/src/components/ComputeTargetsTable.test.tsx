import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ComputeTargetsTable } from './ComputeTargetsTable';
import { TargetCheckPanel } from './TargetCheckPanel';
import { computeTarget, siteTarget } from '../../tests/fixtures/execution';

const renderTable = () =>
  renderToStaticMarkup(
    <ComputeTargetsTable
      targets={[computeTarget, siteTarget]}
      canManage
      pending={false}
      onToggleEnabled={() => undefined}
      onEdit={() => undefined}
      onCheck={() => undefined}
    />,
  );

describe('Compute targetの一覧', () => {
  it('siteには投入方式・CPU・arrayの印を付け、接続先とGPU IDの代わりに説明を出す', () => {
    const html = renderTable();
    expect(html).toContain('手動投入');
    expect(html).toContain('arm64');
    expect(html).toContain('array対応');
    expect(html).toContain('サイト側の設定');
    expect(html).toContain('Jobごとに数を指定');
    expect(html).toContain('worker@worker.invalid:22');
  });

  it('siteの接続確認は押せないボタンと、launcherが投入する説明だけを表示する', () => {
    const html = renderToStaticMarkup(
      <TargetCheckPanel target={siteTarget} onTargetSaved={() => undefined} />,
    );
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>/);
    expect(html).toContain('mado-tracking submit');
    expect(html).not.toContain('まだ接続確認をしていません');
  });
});
