// The launchers tab of the global administration: registering launchers and their tokens.
export const launchersText = {
  launchers: 'launcher',
  launchersDescription:
    'launcherは、自動投入の計算機へSSHで入ってJobを投入します。launcherごとにtokenを1本発行し、launcherのホストのtoken_fileに置きます。計算機・鍵・job shellの設定は、launcherがWebから読みます。',
  newLauncher: 'launcherを登録',
  noLaunchers: 'launcherはまだ登録されていません。',
  launcherStatus: '状態',
  launcherActive: '有効',
  launcherRevoked: '失効',
  launcherLastSeen: '最後の応答',
  launcherNeverSeen: 'まだ応答がありません',
  launcherTokenPrefix: 'tokenの先頭',
  launcherCreatedAt: '登録日時',
  launcherRotateToken: 'tokenを作り直す',
  launcherRotateTitle: 'launcherのtokenを作り直す',
  launcherRevoke: '失効させる',
  launcherRevokeTitle: 'launcherを失効させる',
  launcherTokenOnce:
    'tokenは一度だけ表示されます。閉じる前に、launcherのホストのtoken_file（mode 600、launcherのユーザーの所有）に保存してください。',
  launcherTokenValue: 'launcherのtoken',
  launcherConfigExample: 'launcher.tomlの例',
  launcherConfigExampleHint:
    'launcher.tomlには起動に要るものだけを書きます。担当する計算機・鍵・job shellは、launcherがWebから読みます。',
  launcherConfigApiUrlComment:
    'launcherから届くtrackingのURL。同じcomposeの中で動かすときはAPIのURL（例: http://api:4182）',
  launcherConfigTokenFileComment: '上のtokenだけを書いたファイル（mode 600、launcherのユーザーの所有）',
  launcherConfigStateComment:
    '秘密鍵・known_hosts・投入中の記録を置くディレクトリ。launcherごとに別にし、再起動しても消しません（消すと鍵を登録し直します）',
  launcherConfigPollComment: '設定を読み、投入を受け取る間隔（秒）',
  launcherConfigRegistryComment:
    '任意: 全siteで共通の、imageをpullするためのtoken（JSON {"username": ..., "password": ...}、mode 600）',
} as const;

// Text that embeds values.
export const launchersTextTemplates = {
  launcherTokenTitle: (name: string) => `launcher「${name}」のtoken`,
  launcherRotateConfirm: (name: string) =>
    `「${name}」の今のtokenを失効させ、新しいtokenを発行します。launcherのtoken_fileを新しいtokenに置き換えるまで、このlauncherは投入できません。`,
  launcherRevokeConfirm: (name: string) =>
    `「${name}」とそのtokenを失効させます。このlauncherを選んだ計算機のJobは、別のlauncherを選ぶまで投入されません。`,
  launcherConfigHeader: (name: string) => `mado-tracking-launcher「${name}」の設定`,
};
