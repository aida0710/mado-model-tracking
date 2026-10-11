import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ComputeTargetDetails } from '@mmt/contracts';
import { ComputeTargetsTable } from './ComputeTargetsTable';
import { computeTargetDetails } from '../../tests/fixtures/execution';
import {
  globalSiteDetails,
  ownedSiteDetails,
  publicSiteForUser,
} from '../../tests/fixtures/siteComputers';

const renderTable = (targets: ComputeTargetDetails[], userId: string) =>
  renderToStaticMarkup(<ComputeTargetsTable targets={targets} user={{ id: userId }} />);

describe('プロジェクトのComputeのコンピュータ一覧', () => {
  it('siteには投入方式・CPU・arrayの印を付け、設定の見える人には接続先を出す', () => {
    const html = renderTable([computeTargetDetails, globalSiteDetails], 'admin');
    expect(html).toContain('自動投入');
    expect(html).toContain('arm64');
    expect(html).toContain('array対応');
    expect(html).toContain('login.example.invalid:2222');
    expect(html).toContain('Jobごとに数を指定');
    expect(html).toContain('worker@worker.invalid:22');
  });

  it('所有者と公開範囲を出し、Privateには鍵の印を付ける', () => {
    const html = renderTable([{ ...ownedSiteDetails, visibility: 'private' }], 'alice');
    expect(html).toContain('自分');
    expect(html).toContain('Private');
    expect(html).toContain('lucide-lock');
    expect(renderTable([publicSiteForUser], 'bob')).toContain('Alice');
  });

  it('読み取りだけで、編集・有効の切り替え・詳細を開くボタンを出さない', () => {
    const html = renderTable([computeTargetDetails, ownedSiteDetails], 'alice');
    expect(html).not.toContain('<button');
    expect(html).not.toContain('<input');
    expect(html).toContain('有効');
  });
});
