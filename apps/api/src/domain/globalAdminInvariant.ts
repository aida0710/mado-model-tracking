// The app must always keep one active global administrator (local or SSO) who can recover access.

export interface GlobalAdminChange {
  userId: string;
  // The values after the change; omitted fields stay as they are.
  isAdmin?: boolean;
  status?: 'active' | 'disabled';
}

// activeAdminIds are the users who are active global administrators before the change.
// The caller reads them under a lock so two concurrent demotions cannot both pass.
export function removesLastGlobalAdmin(
  activeAdminIds: readonly string[],
  change: GlobalAdminChange,
): boolean {
  if (!activeAdminIds.includes(change.userId)) return false;
  const staysActiveAdmin = change.isAdmin !== false && change.status !== 'disabled';
  if (staysActiveAdmin) return false;
  return activeAdminIds.every((userId) => userId === change.userId);
}
