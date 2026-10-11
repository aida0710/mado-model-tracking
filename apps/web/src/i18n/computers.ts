import type { ComputeTargetVisibility } from '@mmt/contracts';

// 全体設定 → コンピュータ (/settings/computers): every computer with its visibility and state, and
// the read-only list of the computers one may use on the Project's Compute page.
export const computersText = {
  computersHint:
    'すべてのコンピュータが出ます。自分が使えないもの（他の人のPrivate）は、名前・種類・所有者・公開範囲・状態だけを出します。',
  noComputers: 'コンピュータはまだありません',
  computerKind: '種類',
  computerOwner: '所有者',
  computerVisibility: '公開範囲',
  computerState: '状態',
  computerUsable: '自分が使えるか',
  computerUsableYes: '使える',
  computerUsableNo: '使えない',
  computerEnabled: '有効',
  computerDisabled: '無効',
  computerEnable: '有効にする',
  computerDisable: '無効にする',
  computerLauncherMissing: 'ランチャー未設定',
  computerLauncherRevoked: 'ランチャーは失効',
  computerLauncherNeverSeen: 'ランチャーの応答なし',
  computerLocation: '接続先',
  computerVisibilityPublicHint: 'どのプロジェクトのJobも、このコンピュータで動かせます。',
  computerVisibilityPrivateHint:
    '所有者と、所有者が作ったService AccountのJobだけが動きます。フック・自動実行・Task・Sweepも、それらの所有者がこのコンピュータの所有者のときだけ動きます。全体管理者も、所有者でなければ動かせません。',
  ownerlessComputerVisibilityNotice:
    'このコンピュータには所有者がいないので、Publicのままです（Privateにはできません）。',
  siteComputerNotice:
    'site（スパコン・GPUサーバー・自分のPCなど）を追加します。追加した人が所有者になります。',
  projectComputersHint:
    'このプロジェクトで自分が使えるコンピュータです。追加・設定・job shell・鍵は、全体設定の「コンピュータ」で扱います。',
  openComputerSettings: '全体設定の「コンピュータ」を開く',
} as const;

// Text that embeds values.
export const computersTextTemplates = {
  computerLauncherSeen: (name: string, lastSeen: string) => `${name}（最終応答 ${lastSeen}）`,
};

export const computerVisibilityHints = {
  public: computersText.computerVisibilityPublicHint,
  private: computersText.computerVisibilityPrivateHint,
} satisfies Record<ComputeTargetVisibility, string>;
