import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ComputeTargetOverview } from '@mmt/contracts';
import { ComputerOverviewTable } from './ComputerOverviewTable';
import {
  automaticSiteOverview,
  ownSiteOverview,
  privatePcOverview,
  publicSshOverview,
} from '../../tests/fixtures/computers';

const renderTable = (targets: ComputeTargetOverview[], userId = 'bob') =>
  renderToStaticMarkup(
    <ComputerOverviewTable
      targets={targets}
      user={{ id: userId }}
      selectedTargetId={null}
      pending={false}
      onOpen={() => undefined}
      onEdit={() => undefined}
      onToggleEnabled={() => undefined}
    />,
  );

describe('全体設定のコンピュータ一覧', () => {
  it('他の人のPrivateも名前・種類・所有者・公開範囲・状態だけで出し、詳細は開けない', () => {
    const html = renderTable([publicSshOverview, privatePcOverview]);
    expect(html).toContain('Alice PC');
    expect(html).toContain('Alice');
    expect(html).toContain('Private');
    expect(html).toContain('lucide-lock');
    expect(html).toContain('手動投入');
    expect(html).toContain('使えない');
    expect(html).not.toContain('data-testid="target-details-pc"');
    expect(html).toContain('data-testid="target-details-target"');
  });

  it('使えるものと管理するものは詳細を開け、編集・有効の切り替えは管理する人だけ', () => {
    const html = renderTable([publicSshOverview, ownSiteOverview]);
    expect(html).toContain('data-testid="target-details-bob-site"');
    expect(html).toContain('data-testid="target-edit-bob-site"');
    expect(html).toContain('data-testid="target-toggle-bob-site"');
    expect(html).not.toContain('data-testid="target-edit-target"');
    expect(html).toContain('自分');
  });

  it('管理だけできる他人のPrivate（全体管理者）は、開けるが「使えない」と出す', () => {
    const html = renderTable([{ ...privatePcOverview, canManage: true }], 'admin');
    expect(html).toContain('data-testid="target-details-pc"');
    expect(html).toContain('data-testid="target-edit-pc"');
    expect(html).toContain('使えない');
  });

  it('ssh・localの接続確認は管理する人だけに出し、siteには出さない', () => {
    const html = renderTable([{ ...publicSshOverview, canManage: true }, ownSiteOverview]);
    expect(html).toContain('data-testid="target-check-target"');
    expect(html).not.toContain('data-testid="target-check-bob-site"');
  });

  it('自動投入のsiteの状態にはランチャーの様子を、所有者のいないものには「全体」を出す', () => {
    const html = renderTable([automaticSiteOverview, { ...publicSshOverview, ownerUserId: null, ownerName: null }]);
    expect(html).toContain('main（最終応答');
    expect(html).toContain('全体');
    expect(html).toContain('有効');
  });
});
