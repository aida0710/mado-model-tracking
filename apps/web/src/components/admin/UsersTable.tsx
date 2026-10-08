import type { AdminUser } from '@mmt/contracts';
import { DataTable } from '../DataTable';
import { formatDate } from '../../lib/format';
import { isSsoUser, userAuthSourceLabels } from '../../lib/adminUserDisplay';
import { text } from '../../i18n/catalog';

export type UserAction = 'makeAdmin' | 'removeAdmin' | 'resetPassword' | 'disable' | 'enable';

/** Which actions the API would accept for this user; SSO roles and names come from the IdP. */
function availableActions(user: AdminUser): UserAction[] {
  const actions: UserAction[] = [];
  if (!isSsoUser(user) && user.kind === 'human')
    actions.push(user.isAdmin ? 'removeAdmin' : 'makeAdmin');
  if (user.authSources.includes('local')) actions.push('resetPassword');
  actions.push(user.status === 'active' ? 'disable' : 'enable');
  return actions;
}

const actionLabels: Record<UserAction, string> = {
  makeAdmin: text.userMakeAdmin,
  removeAdmin: text.userRemoveAdmin,
  resetPassword: text.userResetPassword,
  disable: text.userDisable,
  enable: text.userEnable,
};

export function UsersTable({
  users,
  onAction,
}: {
  users: AdminUser[];
  onAction: (user: AdminUser, action: UserAction) => void;
}) {
  return (
    <DataTable
      items={users}
      rowKey={(user) => user.id}
      empty={text.userNoMatches}
      columns={[
        {
          key: 'name',
          label: text.displayName,
          render: (user) => (
            <div className="user-name">
              <strong>{user.displayName}</strong>
              {user.username && <span className="muted mono">{user.username}</span>}
              {user.kind === 'service' && <span className="muted">{text.userServiceAccount}</span>}
            </div>
          ),
        },
        { key: 'email', label: text.email, render: (user) => user.email || '—' },
        {
          key: 'authSources',
          label: text.userAuthSources,
          render: (user) => userAuthSourceLabels(user).join(' / '),
        },
        {
          key: 'status',
          label: text.userStatusFilter,
          render: (user) => (
            <span className={`user-status ${user.status}`}>
              {user.status === 'active' ? text.userStatusActive : text.userStatusDisabled}
            </span>
          ),
        },
        {
          key: 'admin',
          label: text.userGlobalAdmin,
          render: (user) => (
            <div className="user-admin">
              <span>{user.isAdmin ? text.userIsAdmin : text.userIsNotAdmin}</span>
              {isSsoUser(user) && <span className="muted">{text.userAdminFromSso}</span>}
            </div>
          ),
        },
        {
          key: 'lastLogin',
          label: text.userLastLogin,
          render: (user) => formatDate(user.lastLoginAt),
        },
        {
          key: 'actions',
          label: text.userActions,
          render: (user) => (
            <div className="user-actions">
              {availableActions(user).map((action) => (
                <button
                  key={action}
                  type="button"
                  className={action === 'disable' ? 'button small danger' : 'button small'}
                  onClick={() => onAction(user, action)}
                >
                  {actionLabels[action]}
                </button>
              ))}
            </div>
          ),
        },
      ]}
    />
  );
}
