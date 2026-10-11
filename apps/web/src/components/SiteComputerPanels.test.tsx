import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  ManualSubmissionGuide,
  ManualSubmissionNotice,
  WaitingJobNotice,
  WaitingJobSubmission,
} from './ManualSubmissionNotice';
import { SiteConnectionCheckList, SiteConnectionChecks } from './SiteConnectionChecks';
import { SiteLoginKey } from './SiteLoginKey';
import { SitePersonalSettingsList } from './SitePersonalSettingsTable';
import { LaunchersTable } from './admin/LaunchersTable';
import type { ManualSiteOwnership } from '../lib/manualSubmission';
import { failedCheck, launcher, personalSettings, readyKey } from '../../tests/fixtures/siteComputers';

// The scope of --all: the token's Project only, once per Project the PC is shared with.
const ALL_SCOPE_NOTE = '--allで受け取るのは、使ったtokenのProjectのJobです。';
// Someone else's computer may be their PC or a site each requester logs in to: both are said.
const OWNER_SUBMITS_NOTE =
  'この計算機はAliceさんの計算機です。所有者が--watch --allで待ち受けている計算機（所有者のPCなど）では、所有者の側で投入されます。';
const someoneElse: ManualSiteOwnership = { kind: 'someoneElse', ownerName: 'Alice' };

describe('手動投入の案内', () => {
  it('計算機の詳細: 1回の投入とPCでの待ち受けを出し、--allとその範囲は所有者にだけ出す', () => {
    const global = renderToStaticMarkup(
      <ManualSubmissionGuide targetId="pc" ownership={{ kind: 'global' }} />,
    );
    expect(global).toContain('mado-tracking submit --site pc</code>');
    expect(global).toContain('mado-tracking submit --site pc --watch</code>');
    expect(global).not.toContain('--all');
    const own = renderToStaticMarkup(<ManualSubmissionGuide targetId="pc" ownership={{ kind: 'own' }} />);
    expect(own).toContain('mado-tracking submit --site pc --watch --all</code>');
    expect(own).toContain(ALL_SCOPE_NOTE);
    expect(own).toContain('Projectごとに、そのProjectのtokenで--watch --allを動かします。');
    expect(own).not.toContain('さんの計算機です');
  });

  it('計算機の詳細: ほかの人の計算機では、今のコマンドに所有者の側で投入されることがある補足を足す', () => {
    const html = renderToStaticMarkup(<ManualSubmissionGuide targetId="pc" ownership={someoneElse} />);
    expect(html).toContain('mado-tracking submit --site pc</code>');
    expect(html).toContain('mado-tracking submit --site pc --watch</code>');
    expect(html).not.toContain('--all</code>');
    expect(html).toContain(OWNER_SUBMITS_NOTE);
    expect(html).not.toContain(ALL_SCOPE_NOTE);
  });

  it('待っているJobには本人のコマンドを出し、所有者には--allとその範囲、ほかの人の計算機では補足も出す', () => {
    const global = renderToStaticMarkup(
      <WaitingJobSubmission targetId="site" ownership={{ kind: 'global' }} />,
    );
    expect(global).toContain('mado-tracking submit --site site</code>');
    expect(global).not.toContain('--all');
    const own = renderToStaticMarkup(<WaitingJobSubmission targetId="pc" ownership={{ kind: 'own' }} />);
    expect(own).toContain('mado-tracking submit --site pc</code>');
    expect(own).toContain('mado-tracking submit --site pc --watch --all</code>');
    expect(own).toContain('所有者: 共有したProjectのメンバーのJobも待ち受けて投入する');
    expect(own).toContain(ALL_SCOPE_NOTE);
    // A supercomputer with OTP is submitted by each requester with their own account, so the
    // command stays; where the owner waits on their PC, the owner's side submits it.
    const others = renderToStaticMarkup(<WaitingJobSubmission targetId="pc" ownership={someoneElse} />);
    expect(others).toContain('mado-tracking submit --site pc</code>');
    expect(others).not.toContain('--all</code>');
    expect(others).toContain(OWNER_SUBMITS_NOTE);
  });

  it('Jobの詳細: 依頼した本人には実行するコマンドの案内を出し、ほかの人の計算機では補足も出す', () => {
    const notice = (ownership: ManualSiteOwnership, isRequester: boolean) =>
      renderToStaticMarkup(
        <WaitingJobNotice targetId="pc" ownership={ownership} isRequester={isRequester} />,
      );
    expect(notice({ kind: 'global' }, true)).toContain('あなたが依頼したJobです。');
    expect(notice({ kind: 'global' }, false)).toContain('依頼した本人がsite');
    expect(notice({ kind: 'own' }, false)).toContain('mado-tracking submit --site pc --watch --all</code>');
    const requested = notice(someoneElse, true);
    expect(requested).toContain('あなたが依頼したJobです。');
    expect(requested).toContain('次のコマンドを実行して投入してください');
    expect(requested).toContain('mado-tracking submit --site pc</code>');
    expect(requested).toContain(OWNER_SUBMITS_NOTE);
    expect(notice(someoneElse, false)).toContain(OWNER_SUBMITS_NOTE);
  });

  it('Jobsの上の案内: 所有者の計算機にだけ--allを出し、ほかの人の計算機ではコマンドと補足を出す', () => {
    const html = renderToStaticMarkup(
      <ManualSubmissionNotice
        groups={[
          { targetId: 'pc', targetName: 'My PC', waitingJobs: 2, ownership: { kind: 'own' } },
          { targetId: 'site', targetName: 'Supercomputer', waitingJobs: 1, ownership: { kind: 'global' } },
          { targetId: 'other', targetName: 'Miyabi', waitingJobs: 1, ownership: someoneElse },
        ]}
      />,
    );
    expect(html).toContain('My PC: 2件');
    expect(html).toContain('mado-tracking submit --site pc --watch --all</code>');
    expect(html).toContain('mado-tracking submit --site site</code>');
    expect(html).not.toContain('mado-tracking submit --site site --watch --all');
    expect(html).toContain('mado-tracking submit --site other</code>');
    expect(html).not.toContain('mado-tracking submit --site other --watch --all');
    expect(html).toContain(OWNER_SUBMITS_NOTE);
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
    expect(requested).toContain('ランチャーが鍵を作るのを待っています');
    // The managers' table shows the same state, so one's own key does too while it waits.
    expect(requested).toContain('作成待ち');
    expect(requested).toContain('依頼日時');
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

  it('launcherが鍵を作り終えるまで、接続確認のボタンは押せない', () => {
    const checkButton = (isKeyReady: boolean) =>
      renderToStaticMarkup(
        <SiteConnectionChecks targetId="site" personal userId="alice" isKeyReady={isKeyReady} />,
      ).match(/<button[^>]*>(?:(?!<\/button>).)*接続を確認<\/button>/)?.[0];
    expect(checkButton(false)).toContain('disabled=""');
    expect(checkButton(true)).not.toContain('disabled');
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
