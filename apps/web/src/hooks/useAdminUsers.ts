import { useState } from 'react';
import type { AdminUserQuery } from '@mmt/contracts';
import { adminUsersApi } from '../api/adminUsers';
import { useQuery } from './useQuery';

/** The admin users tab's list and the filter it was loaded with. */
export function useAdminUsers() {
  const [filter, setFilter] = useState<AdminUserQuery>({});
  const users = useQuery(`admin-users:${JSON.stringify(filter)}`, (signal) =>
    adminUsersApi.list(filter, signal),
  );
  return { users, filter, setFilter };
}
