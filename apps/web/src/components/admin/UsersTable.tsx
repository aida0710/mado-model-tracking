import type { AdminUser } from '@mmt/contracts';
import { ResponsiveTable } from '../ResponsiveTable';
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
    <ResponsiveTable
      rows={users}
      rowKey={(user) => user.id}
      empty={text.userNoMatches}
      columns={[
        {
          key: 'name',
          priority: 'primary',
          header: text.displayName,
          render: (user) => (
            <div className="user-name">
              <strong>{user.displayName}</strong>
              {user.username && <span className="muted mono">{user.username}</span>}
              {user.kind === 'service' && <span className="muted">{text.userServiceAccount}</span>}
            </div>
          ),
        },
        {
          key: 'email',
          priority: 'secondary',
          header: text.email,
          render: (user) => user.email || '—',
        },
        {
          key: 'authSources',
          priority: 'secondary',
          header: text.userAuthSources,
          render: (user) => userAuthSourceLabels(user).join(' / '),
        },
        {
          key: 'status',
          priority: 'primary',
          header: text.userStatusFilter,
          render: (user) => (
            <span className={`user-status ${user.status}`}>
              {user.status === 'active' ? text.userStatusActive : text.userStatusDisabled}
            </span>
          ),
        },
        {
          key: 'admin',
          priority: 'secondary',
          header: text.userGlobalAdmin,
          render: (user) => (
            <div className="user-admin">
              <span>{user.isAdmin ? text.userIsAdmin : text.userIsNotAdmin}</span>
              {isSsoUser(user) && <span className="muted">{text.userAdminFromSso}</span>}
            </div>
          ),
        },
        {
          key: 'lastLogin',
          priority: 'secondary',
          header: text.userLastLogin,
          render: (user) => formatDate(user.lastLoginAt),
        },
        {
          key: 'actions',
          priority: 'secondary',
          header: text.userActions,
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
