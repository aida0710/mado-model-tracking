import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ManualSubmissionGuide } from './ManualSubmissionNotice';
import { SiteConnectionCheckList } from './SiteConnectionChecks';
import { SiteLoginKey } from './SiteLoginKey';
import { SitePersonalSettingsList } from './SitePersonalSettingsTable';
import { LaunchersTable } from './admin/LaunchersTable';
import { failedCheck, launcher, personalSettings, readyKey } from '../../tests/fixtures/siteComputers';

describe('手動投入の案内', () => {
  it('1回の投入とPCでの待ち受けを出し、--allは所有者にだけ出す', () => {
    const forMember = renderToStaticMarkup(<ManualSubmissionGuide targetId="pc" isOwner={false} />);
    expect(forMember).toContain('mado-tracking submit --site pc</code>');
    expect(forMember).toContain('mado-tracking submit --site pc --watch</code>');
    expect(forMember).not.toContain('--all');
    const forOwner = renderToStaticMarkup(<ManualSubmissionGuide targetId="pc" isOwner />);
    expect(forOwner).toContain('mado-tracking submit --site pc --watch --all</code>');
  });
});

describe('launcherが作った鍵', () => {
  it('作成済みの鍵は公開鍵と指紋を出し、登録するアカウントを案内する', () => {
    const html = renderToStaticMarkup(
      <SiteLoginKey targetId="site" siteKey={readyKey} personal={false} accountName="mmt" onRequested={() => undefined} />,
    );
    expect(html).toContain(readyKey.publicKey);
    expect(html).toContain('SHA256:examplefingerprint');
    expect(html).toContain('共用アカウント（mmt）の~/.ssh/authorized_keys');
    expect(html).toContain('鍵を作り直す');
  });

  it('作成待ちの鍵は待っていると出し、鍵が無ければ依頼のボタンにする', () => {
    const requested = renderToStaticMarkup(
      <SiteLoginKey
        targetId="site"
        siteKey={{ ...readyKey, status: 'requested', publicKey: null, fingerprint: null, readyAt: null }}
        personal
        accountName="alice"
        onRequested={() => undefined}
      />,
    );
    expect(requested).toContain('launcherが鍵を作るのを待っています');
    expect(requested).not.toContain('authorized_keys');
    const none = renderToStaticMarkup(
      <SiteLoginKey targetId="site" siteKey={null} personal={false} accountName="mmt" onRequested={() => undefined} />,
    );
    expect(none).toContain('鍵はまだありません');
    expect(none).toContain('鍵を依頼する');
  });
});

describe('接続確認の結果', () => {
  it('状態とlauncherの報告を出し、無ければまだ確認していないと出す', () => {
    const html = renderToStaticMarkup(
      <SiteConnectionCheckList checks={[{ ...failedCheck, id: 'queued', status: 'queued', message: null, finishedAt: null }, failedCheck]} />,
    );
    expect(html).toContain('確認中');
    expect(html).toContain('失敗');
    expect(html).toContain('Permission denied (publickey).');
    expect(renderToStaticMarkup(<SiteConnectionCheckList checks={[]} />)).toContain('まだ確認していません');
  });
});

describe('利用者の設定の一覧', () => {
  it('利用者・アカウント・変数・鍵を出し、作業ディレクトリが無ければ計算機の設定を使うと出す', () => {
    const html = renderToStaticMarkup(<SitePersonalSettingsList items={[personalSettings]} />);
    expect(html).toContain('Alice');
    expect(html).toContain('alice');
    expect(html).toContain('GROUP=gaa50000');
    expect(html).toContain('作成済み');
    expect(html).toContain('計算機の設定');
  });
});

describe('launcherの一覧', () => {
  it('tokenの先頭と最後の応答を出し、失効したlauncherには操作を出さない', () => {
    const html = renderToStaticMarkup(
      <LaunchersTable
        launchers={[
          launcher,
          { ...launcher, id: 'old', name: 'old', lastSeenAt: null, revokedAt: '2026-10-10T02:00:00Z' },
        ]}
        onRotateToken={() => undefined}
        onRevoke={() => undefined}
      />,
    );
    expect(html).toContain('mmt_abcdefgh…');
    expect(html).toContain('まだ応答がありません');
    expect(html).toContain('>失効</span>');
    expect(html.match(/tokenを作り直す/g)).toHaveLength(1);
  });
});
