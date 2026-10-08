import type { AdminUser, AdminUserQuery } from '@mmt/contracts';
import { first, rows, type Connection } from '../db/database.js';
import { userColumns } from './identityRepository.js';

const adminUserColumns = `${userColumns},u.kind,u.last_login_at,u.created_at`;

function containsPattern(query: string): string {
  return `%${query.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
}

export async function listAdminUsers(
  connection: Connection,
  filter: AdminUserQuery & { limit: number },
): Promise<AdminUser[]> {
  return rows<AdminUser>(
    connection,
    `SELECT ${adminUserColumns} FROM users u
    WHERE ($1::text IS NULL OR u.email ILIKE $1 OR u.username ILIKE $1 OR u.display_name ILIKE $1)
    AND ($2::text IS NULL OR u.status=$2) AND ($3::text IS NULL OR u.kind=$3)
    ORDER BY lower(u.display_name),u.id LIMIT $4`,
    [
      filter.query ? containsPattern(filter.query) : null,
      filter.status ?? null,
      filter.kind ?? null,
      filter.limit,
    ],
  );
}

export async function findAdminUser(
  connection: Connection,
  userId: string,
): Promise<AdminUser | undefined> {
  return first<AdminUser>(connection, `SELECT ${adminUserColumns} FROM users u WHERE u.id=$1`, [
    userId,
  ]);
}

// Locks the row so a concurrent change to the same user waits for this transaction.
export async function lockAdminUser(
  connection: Connection,
  userId: string,
): Promise<AdminUser | undefined> {
  await connection.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [userId]);
  return findAdminUser(connection, userId);
}

export async function insertLocalUser(
  connection: Connection,
  user: {
    username: string;
    displayName: string;
    email: string;
    isAdmin: boolean;
    passwordHash: string;
  },
): Promise<string> {
  const created = await first<{ id: string }>(
    connection,
    'INSERT INTO users(username,email,display_name,is_admin) VALUES($1,$2,$3,$4) RETURNING id',
    [user.username, user.email, user.displayName, user.isAdmin],
  );
  await connection.query(
    'INSERT INTO user_local_credentials(user_id,password_hash,must_change_password) VALUES($1,$2,true)',
    [created!.id, user.passwordHash],
  );
  return created!.id;
}

export async function isUsernameTaken(connection: Connection, username: string): Promise<boolean> {
  return !!(await first(connection, 'SELECT 1 FROM users WHERE lower(username)=lower($1)', [
    username,
  ]));
}

export async function updateAdminUser(
  connection: Connection,
  change: { userId: string; status: AdminUser['status']; displayName: string; isAdmin: boolean },
): Promise<void> {
  await connection.query(
    'UPDATE users SET status=$2,display_name=$3,is_admin=$4,updated_at=now() WHERE id=$1',
    [change.userId, change.status, change.displayName, change.isAdmin],
  );
}

// Unlike a self-service change this does not compare the old hash: the administrator replaces it.
export async function resetLocalPassword(
  connection: Connection,
  reset: { userId: string; passwordHash: string },
): Promise<boolean> {
  const updated = await connection.query(
    `UPDATE user_local_credentials SET password_hash=$2,must_change_password=true,password_changed_at=now()
    WHERE user_id=$1`,
    [reset.userId, reset.passwordHash],
  );
  return updated.rowCount === 1;
}

export async function findGroupsSyncedAt(
  connection: Connection,
  userId: string,
): Promise<string | null> {
  const synced = await first<{ syncedAt: string | null }>(
    connection,
    'SELECT max(synced_at) AS synced_at FROM user_groups WHERE user_id=$1',
    [userId],
  );
  return synced?.syncedAt ?? null;
}
