import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ComputeTargetDetails } from '@mmt/contracts';
import { ComputeTargetsTable } from './ComputeTargetsTable';
import { computeTargetDetails } from '../../tests/fixtures/execution';
import {
  globalSiteDetails,
  ownedSiteDetails,
  sharedSiteForMember,
} from '../../tests/fixtures/siteComputers';

const admin = { id: 'admin', isAdmin: true };
const alice = { id: 'alice', isAdmin: false };
const bob = { id: 'bob', isAdmin: false };
const projects = [{ id: 'project', name: 'Speech' }];

const renderTable = (targets: ComputeTargetDetails[], user: { id: string; isAdmin: boolean }) =>
  renderToStaticMarkup(
    <ComputeTargetsTable
      targets={targets}
      user={user}
      projects={projects}
      selectedTargetId={null}
      pending={false}
      onSelect={() => undefined}
      onToggleEnabled={() => undefined}
      onEdit={() => undefined}
    />,
  );

describe('Compute targetの一覧', () => {
  it('siteには投入方式・CPU・arrayの印を付け、全体管理者には設定の接続先を出す', () => {
    const html = renderTable([computeTargetDetails, globalSiteDetails], admin);
    expect(html).toContain('自動投入');
    expect(html).toContain('arm64');
    expect(html).toContain('array対応');
    expect(html).toContain('login.example.invalid:2222');
    expect(html).toContain('Jobごとに数を指定');
    expect(html).toContain('worker@worker.invalid:22');
  });

  it('所有者の名前と共有先を出し、全体の計算機はすべてのProjectで使える', () => {
    const html = renderTable([globalSiteDetails, ownedSiteDetails], admin);
    expect(html).toContain('全体の計算機');
    expect(html).toContain('すべてのProject');
    expect(html).toContain('Aliceさんの計算機');
    expect(html).toContain('Speech');
  });

  it('自分の計算機は「自分の計算機」と出し、所有者は編集できる', () => {
    const html = renderTable([ownedSiteDetails], alice);
    expect(html).toContain('自分の計算機');
    expect(html).toContain('data-testid="target-edit-pc"');
  });

  it('共有された人は、siteの詳細を開けるが編集・有効の切り替えはできず、共有先も見えない', () => {
    const html = renderTable([computeTargetDetails, sharedSiteForMember], bob);
    expect(html).toContain('data-testid="target-details-pc"');
    expect(html).not.toContain('target-edit-');
    expect(html).not.toContain('Speech');
    // An ssh target has no details for a researcher: only global administrators check it.
    expect(html).not.toContain('data-testid="target-details-target"');
    expect(html.match(/<input type="checkbox"[^>]*disabled=""/g)).toHaveLength(2);
  });

  it('ssh targetの接続確認は全体管理者だけに出し、siteには出さない', () => {
    const html = renderTable([computeTargetDetails, globalSiteDetails], admin);
    expect(html).toContain('data-testid="target-check-target"');
    expect(html).not.toContain('data-testid="target-check-site"');
  });
});
