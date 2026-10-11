// The launchers section of the global administration: registering launchers and their tokens.
export const launchersText = {
  launchers: 'ランチャー',
  launchersDescription:
    'ランチャーは、自動投入のコンピュータへSSHで入ってJobを投入します。ランチャーごとにtokenを1本発行し、ランチャーのホストのtoken_fileに置きます。コンピュータ・鍵・job shellの設定は、ランチャーがWebから読みます。',
  newLauncher: 'ランチャーを登録',
  noLaunchers: 'ランチャーはまだ登録されていません。',
  launcherStatus: '状態',
  launcherActive: '有効',
  launcherRevoked: '失効',
  launcherLastSeen: '最後の応答',
  launcherNeverSeen: 'まだ応答がありません',
  launcherTokenPrefix: 'tokenの先頭',
  launcherCreatedAt: '登録日時',
  launcherRotateToken: 'tokenを作り直す',
  launcherRotateTitle: 'ランチャーのtokenを作り直す',
  launcherRevoke: '失効させる',
  launcherRevokeTitle: 'ランチャーを失効させる',
  launcherTokenOnce:
    'tokenは一度だけ表示されます。閉じる前に、ランチャーのホストのtoken_file（mode 600、ランチャーのユーザーの所有）に保存してください。',
  launcherTokenValue: 'ランチャーのtoken',
  launcherConfigExample: 'launcher.tomlの例',
  launcherConfigExampleHint:
    'launcher.tomlには起動に要るものだけを書きます。担当するコンピュータ・鍵・job shellは、ランチャーがWebから読みます。',
  launcherConfigApiUrlComment:
    'ランチャーから届くtrackingのURL。同じcomposeの中で動かすときはAPIのURL（例: http://api:4182）',
  launcherConfigTokenFileComment: '上のtokenだけを書いたファイル（mode 600、ランチャーのユーザーの所有）',
  launcherConfigStateComment:
    '秘密鍵・known_hosts・投入中の記録を置くディレクトリ。ランチャーごとに別にし、再起動しても消しません（消すと鍵を登録し直します）',
  launcherConfigPollComment: '設定を読み、投入を受け取る間隔（秒）',
  launcherConfigRegistryComment:
    '任意: 全siteで共通の、imageをpullするためのtoken（JSON {"username": ..., "password": ...}、mode 600）',
} as const;

// Text that embeds values.
export const launchersTextTemplates = {
  launcherTokenTitle: (name: string) => `ランチャー「${name}」のtoken`,
  launcherRotateConfirm: (name: string) =>
    `「${name}」の今のtokenを失効させ、新しいtokenを発行します。ランチャーのtoken_fileを新しいtokenに置き換えるまで、このランチャーは投入できません。`,
  launcherRevokeConfirm: (name: string) =>
    `「${name}」とそのtokenを失効させます。このランチャーを選んだコンピュータのJobは、別のランチャーを選ぶまで投入されません。`,
  launcherConfigHeader: (name: string) => `mado-tracking-launcher「${name}」の設定`,
};
