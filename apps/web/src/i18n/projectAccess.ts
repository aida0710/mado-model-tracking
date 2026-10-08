// Project members, Authentik group bindings and the user picker on the settings page.
export const projectAccessText = {
  addMember: 'メンバーを追加',
  editMember: 'メンバーを編集',
  removeMember: 'メンバーの直接付与を外す',
  remove: '外す',
  memberUser: 'ユーザー',
  effectiveRole: '実効Role',
  directRole: '直接付与のRole',
  memberSources: '付与元',
  memberSourceDirect: '直接付与',
  memberGrantedByGroup: 'Authentikのgroupで付与',
  memberDisabled: '無効',
  memberDisabledHint: 'このアカウントは無効化されているため、Roleがあってもログインやtokenでの操作はできません。',
  directRoleHint:
    'groupで付与されたRoleの方が高い場合は、そちらが実効Roleになります。groupの権限はAuthentik groupの欄で変更します。',
  userSearchPlaceholder: '名前・メールアドレス・ユーザー名の先頭で検索',
  userSearchNoResults: '一致するユーザーがいません',
  userSearchRequired: '追加するユーザーを選択してください',
  changeSelectedUser: '選び直す',
  lastProjectAdminConflict:
    'Project adminがいなくなるため変更できません。先に別のメンバーかgroupへAdminを付与してください。',
  groupBindings: 'Authentik group',
  groupBindingsDescription:
    'groupに入っている全員へRoleを付与します。groupの所属はSSOのログイン時にAuthentikから同期されます。',
  groupBindingsEmpty: 'groupへの付与はまだありません',
  addGroupBinding: 'groupを追加',
  editGroupBinding: 'groupのRoleを編集',
  removeGroupBinding: 'groupへの付与を外す',
  groupName: 'group名',
  groupNameHint: '候補はログインしたユーザーのgroupです。候補にないgroup名も入力できます。',
  grantedAt: '付与日時',
} as const;

// Text that embeds values.
export const projectAccessTextTemplates = {
  memberSourceGroup: (group: string) => `group ${group}`,
  removeMemberConfirm: (displayName: string, keepsGroupRole: boolean) =>
    `「${displayName}」への直接付与を外します。` +
    (keepsGroupRole
      ? 'groupで付与されたRoleは残ります。'
      : 'このユーザーはこのProjectを使えなくなります。'),
  groupBindingExists: (group: string, role: string) =>
    `group「${group}」は${role}で登録済みです。Roleを変えるときは一覧の「変更」を使ってください。`,
  removeGroupBindingConfirm: (group: string) =>
    `group「${group}」への付与を外します。このgroupだけでRoleを得ていたユーザーは、このProjectを使えなくなります。`,
};
