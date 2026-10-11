import { useState } from 'react';
import type { AdminUser, AdminUserQuery } from '@mmt/contracts';
import { Plus, RefreshCw } from 'lucide-react';
import { adminUsersApi } from '../../api/adminUsers';
import { useAdminUsers } from '../../hooks/useAdminUsers';
import { ConfirmDialog } from '../ConfirmDialog';
import { Dialog } from '../Dialog';
import { Resource } from '../Feedback';
import { AdminSectionHeader } from './AdminSectionHeader';
import { LocalUserDialog } from './LocalUserDialog';
import { TemporaryPasswordNotice } from './TemporaryPasswordNotice';
import { UsersTable, type UserAction } from './UsersTable';
import { text, textTemplates } from '../../i18n/catalog';

interface PendingAction {
  user: AdminUser;
  action: UserAction;
}

// Each action is one confirmation: its title, message, button and the API call it makes.
function confirmation({ user, action }: PendingAction) {
  const name = user.displayName;
  switch (action) {
    case 'disable':
      return {
        title: text.userDisableTitle,
        message: textTemplates.userDisableConfirm(name),
        confirmLabel: text.userDisable,
        destructive: true,
        run: () => adminUsersApi.update(user.id, { status: 'disabled' }),
      };
    case 'enable':
      return {
        title: text.userEnableTitle,
        message: textTemplates.userEnableConfirm(name),
        confirmLabel: text.userEnable,
        destructive: false,
        run: () => adminUsersApi.update(user.id, { status: 'active' }),
      };
    case 'makeAdmin':
      return {
        title: text.userMakeAdminTitle,
        message: textTemplates.userMakeAdminConfirm(name),
        confirmLabel: text.userMakeAdmin,
        destructive: false,
        run: () => adminUsersApi.update(user.id, { isAdmin: true }),
      };
    case 'removeAdmin':
      return {
        title: text.userRemoveAdminTitle,
        message: textTemplates.userRemoveAdminConfirm(name),
        confirmLabel: text.userRemoveAdmin,
        destructive: true,
        run: () => adminUsersApi.update(user.id, { isAdmin: false }),
      };
    case 'resetPassword':
      return {
        title: text.userResetPasswordTitle,
        message: textTemplates.userResetPasswordConfirm(name),
        confirmLabel: text.userResetPassword,
        destructive: true,
        run: () => adminUsersApi.resetPassword(user.id),
      };
  }
}

/** The admin "users" section: search, local account creation, disabling and password resets. */
export function UsersPanel() {
  const { users, filter, setFilter } = useAdminUsers();
  const [searchText, setSearchText] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const [temporaryPassword, setTemporaryPassword] = useState<string | null>(null);
  const pending = pendingAction && confirmation(pendingAction);
  return (
    <section className="admin-users">
      <AdminSectionHeader
        section="users"
        actions={
          <>
            <button className="button primary" onClick={() => setIsCreating(true)}>
              <Plus size={15} />
              {text.newLocalUser}
            </button>
            <button className="icon-button" aria-label={text.refresh} onClick={users.reload}>
              <RefreshCw size={17} />
            </button>
          </>
        }
      />
      <form
        className="admin-users-filter"
        role="search"
        onSubmit={(event) => {
          event.preventDefault();
          setFilter({ ...filter, query: searchText.trim() || undefined });
        }}
      >
        <input
          type="search"
          aria-label={text.userSearch}
          placeholder={text.adminUserSearchPlaceholder}
          value={searchText}
          onChange={(event) => setSearchText(event.target.value)}
        />
        <button className="button">{text.search}</button>
        <select
          aria-label={text.userStatusFilter}
          value={filter.status ?? ''}
          onChange={(event) =>
            setFilter({
              ...filter,
              status: (event.target.value || undefined) as AdminUserQuery['status'],
            })
          }
        >
          <option value="">{text.userStatusAll}</option>
          <option value="active">{text.userStatusActive}</option>
          <option value="disabled">{text.userStatusDisabled}</option>
        </select>
      </form>
      <Resource query={users}>
        {(items) => (
          <UsersTable users={items} onAction={(user, action) => setPendingAction({ user, action })} />
        )}
      </Resource>
      {isCreating && (
        <LocalUserDialog onCreated={users.reload} onClose={() => setIsCreating(false)} />
      )}
      {pendingAction && pending && (
        <ConfirmDialog
          title={pending.title}
          message={pending.message}
          confirmLabel={pending.confirmLabel}
          destructive={pending.destructive}
          onConfirm={async () => {
            const result = await pending.run();
            if ('temporaryPassword' in result) setTemporaryPassword(result.temporaryPassword);
          }}
          onConfirmed={() => {
            setPendingAction(null);
            users.reload();
          }}
          onClose={() => setPendingAction(null)}
        />
      )}
      {temporaryPassword && (
        <Dialog title={text.userResetPasswordTitle} onClose={() => setTemporaryPassword(null)}>
          <TemporaryPasswordNotice password={temporaryPassword} />
          <footer>
            <button
              type="button"
              className="button primary"
              onClick={() => setTemporaryPassword(null)}
            >
              {text.close}
            </button>
          </footer>
        </Dialog>
      )}
    </section>
  );
}
