import type { TokenScope } from '@mmt/contracts';

// Service Accounts, the Project token list and the token dialog on the settings page.
export const serviceAccountsText = {
  serviceAccounts: 'Service Accounts',
  serviceAccountsDescription:
    '人に紐付かないアカウントです。workerや自動実行のtokenをここで発行すると、発行した人がProjectを離れても動き続けます。',
  serviceAccountsEmpty: 'Service Accountはまだありません',
  newServiceAccount: 'Service Accountを作成',
  editServiceAccount: 'Service Accountを編集',
  serviceAccountStatus: '状態',
  serviceAccountActive: '有効',
  serviceAccountDisabled: '無効',
  serviceAccountRoleMissing: 'Roleなし',
  disableServiceAccount: '無効化',
  enableServiceAccount: '有効化',
  issueToken: 'API tokenを発行',
  personalTokens: '自分のAPI token',
  projectTokens: 'Projectのtoken一覧',
  projectTokensDescription:
    'このProjectに限定された、全員とService Accountのtokenです。tokenの値は表示されません。',
  projectTokensEmpty: 'このProjectのtokenはありません',
  ownerTransfer: 'Service Accountへ移す',
  ownerTransferTarget: '移管先のService Account',
  ownerTransferred: '所有者を移しました。',
  tokenOwner: '所有者',
  tokenOwnerUser: 'ユーザー',
  tokenOwnerServiceAccount: 'Service Account',
  tokenPrefix: '先頭',
  legacyToken: '旧形式',
  legacyTokenHint:
    '個人が所有するservice tokenです。所有者がProjectを離れると止まるため、Service Accountのtokenへ置き換えてください。',
  tokenUsage: '設定例',
  tokenAuthentication: '認証方式',
  tokenAuthenticationBearer: 'Bearer（MLflow・Mado SDKの既定）',
  tokenAuthenticationBasic: 'Basic（ユーザー名とパスワードを使うツール。passwordにtoken）',
} as const;

// One line per scope, shown next to the scope in the token dialog.
export const tokenScopeLabels: Record<TokenScope, string> = {
  read: 'read — 読み取り',
  'runs:write': 'runs:write — Runの作成と記録',
  'registry:write': 'registry:write — モデル・データセットの登録',
  'artifacts:write': 'artifacts:write — Artifactの保存',
  'jobs:write': 'jobs:write — Jobの起動と取り消し',
  'worker:execute': 'worker:execute — workerとしてJobを実行',
  admin: 'admin — Projectの管理',
};

// Text that embeds values.
export const serviceAccountsTextTemplates = {
  tokenExpiryDays: (days: number) => `${days}日`,
  serviceAccountTokenTitle: (name: string) => `${name} のtokenを発行`,
  disableServiceAccountConfirm: (name: string) =>
    `「${name}」を無効化します。このService Accountのtokenはすべて、次の要求から使えなくなります。`,
};
