import type { User } from '@mmt/contracts';
import { first, rows, type Connection } from '../db/database.js';

// auth_sources lists the login methods the user holds; development logins hold neither.
export const userColumns = `u.id,u.email,u.display_name,u.is_admin,u.username,u.status,
  ARRAY_REMOVE(ARRAY[
    CASE WHEN EXISTS(SELECT 1 FROM user_local_credentials lc WHERE lc.user_id=u.id) THEN 'local' END,
    CASE WHEN EXISTS(SELECT 1 FROM user_oidc_identities oi WHERE oi.user_id=u.id) THEN 'oidc' END
  ]::text[],NULL) AS auth_sources`;
export const tokenColumns = 'id,name,kind,project_id,scopes,expires_at,last_used_at,created_at';

export interface OidcLoginIdentity {
  issuer: string;
  subject: string;
  email: string;
  emailVerified: boolean;
  groups: string[];
  displayName: string;
  isAdmin: boolean;
}

export interface LocalCredential {
  userId: string;
  passwordHash: string;
  mustChangePassword: boolean;
  status: User['status'];
}

// Development logins and the demo seed identify users by (issuer, subject) on users itself.
export async function upsertIdentity(
  connection: Connection,
  identity: {
    issuer: string;
    subject: string;
    email: string;
    displayName: string;
    isAdmin: boolean;
  },
): Promise<User> {
  const user = await first<User>(
    connection,
    `INSERT INTO users AS u(issuer,subject,email,display_name,is_admin) VALUES($1,$2,$3,$4,$5)
    ON CONFLICT(issuer,subject) DO UPDATE SET email=EXCLUDED.email,display_name=EXCLUDED.display_name,is_admin=EXCLUDED.is_admin RETURNING ${userColumns}`,
    [identity.issuer, identity.subject, identity.email, identity.displayName, identity.isAdmin],
  );
  return user!;
}

export async function findUser(connection: Connection, userId: string): Promise<User | undefined> {
  return first<User>(connection, `SELECT ${userColumns} FROM users u WHERE u.id=$1`, [userId]);
}

// Finds the user linked to an OIDC subject, creating it on first login. The caller holds a transaction.
export async function upsertOidcUser(
  connection: Connection,
  identity: OidcLoginIdentity,
): Promise<User> {
  const linked = await first<{ userId: string }>(
    connection,
    'SELECT user_id FROM user_oidc_identities WHERE issuer=$1 AND subject=$2 FOR UPDATE',
    [identity.issuer, identity.subject],
  );
  const profile = [identity.email, identity.displayName, identity.isAdmin];
  const user = linked
    ? await first<User>(
        connection,
        `UPDATE users u SET email=$2,display_name=$3,is_admin=$4,last_login_at=now(),updated_at=now()
        WHERE u.id=$1 RETURNING ${userColumns}`,
        [linked.userId, ...profile],
      )
    : await first<User>(
        connection,
        `INSERT INTO users AS u(email,display_name,is_admin,last_login_at) VALUES($1,$2,$3,now())
        RETURNING ${userColumns}`,
        profile,
      );
  await connection.query(
    `INSERT INTO user_oidc_identities(issuer,subject,user_id,email_at_login,email_verified,groups_at_login,last_login_at)
    VALUES($1,$2,$3,$4,$5,$6,now())
    ON CONFLICT(issuer,subject) DO UPDATE SET email_at_login=EXCLUDED.email_at_login,
    email_verified=EXCLUDED.email_verified,groups_at_login=EXCLUDED.groups_at_login,last_login_at=now()`,
    [
      identity.issuer,
      identity.subject,
      user!.id,
      identity.email,
      identity.emailVerified,
      identity.groups,
    ],
  );
  // The identity row exists before the user's columns are read, so auth_sources includes oidc.
  return (await findUser(connection, user!.id))!;
}

export async function findLocalCredentialByUsername(
  connection: Connection,
  username: string,
): Promise<LocalCredential | undefined> {
  return first<LocalCredential>(
    connection,
    `SELECT c.user_id,c.password_hash,c.must_change_password,u.status
    FROM user_local_credentials c JOIN users u ON u.id=c.user_id WHERE lower(u.username)=lower($1)`,
    [username],
  );
}

export async function findLocalCredential(
  connection: Connection,
  userId: string,
): Promise<LocalCredential | undefined> {
  return first<LocalCredential>(
    connection,
    `SELECT c.user_id,c.password_hash,c.must_change_password,u.status
    FROM user_local_credentials c JOIN users u ON u.id=c.user_id WHERE c.user_id=$1`,
    [userId],
  );
}

// Compare-and-set on the verified hash: a concurrent password change makes this return false.
export async function replaceLocalPassword(
  connection: Connection,
  change: {
    userId: string;
    verifiedPasswordHash: string;
    newPasswordHash: string;
    mustChangePassword: boolean;
  },
): Promise<boolean> {
  const updated = await connection.query(
    `UPDATE user_local_credentials SET password_hash=$3,must_change_password=$4,password_changed_at=now()
    WHERE user_id=$1 AND password_hash=$2`,
    [change.userId, change.verifiedPasswordHash, change.newPasswordHash, change.mustChangePassword],
  );
  return updated.rowCount === 1;
}

// Rehashing keeps password_changed_at because the password itself did not change.
export async function rehashLocalPassword(
  connection: Connection,
  change: { userId: string; verifiedPasswordHash: string; newPasswordHash: string },
): Promise<boolean> {
  const updated = await connection.query(
    'UPDATE user_local_credentials SET password_hash=$3 WHERE user_id=$1 AND password_hash=$2',
    [change.userId, change.verifiedPasswordHash, change.newPasswordHash],
  );
  return updated.rowCount === 1;
}

export async function recordLogin(connection: Connection, userId: string): Promise<void> {
  await connection.query('UPDATE users SET last_login_at=now() WHERE id=$1', [userId]);
}

// Creates or resets a local administrator. The password must be changed at the next login.
export async function upsertLocalAdministrator(
  connection: Connection,
  administrator: { username: string; email: string; displayName: string; passwordHash: string },
): Promise<User> {
  const existing = await first<{ id: string }>(
    connection,
    'SELECT id FROM users WHERE lower(username)=lower($1) FOR UPDATE',
    [administrator.username],
  );
  const user = existing
    ? await first<{ id: string }>(
        connection,
        `UPDATE users SET is_admin=true,status='active',updated_at=now() WHERE id=$1 RETURNING id`,
        [existing.id],
      )
    : await first<{ id: string }>(
        connection,
        `INSERT INTO users(username,email,display_name,is_admin) VALUES($1,$2,$3,true) RETURNING id`,
        [administrator.username, administrator.email, administrator.displayName],
      );
  await connection.query(
    `INSERT INTO user_local_credentials(user_id,password_hash,must_change_password) VALUES($1,$2,true)
    ON CONFLICT(user_id) DO UPDATE SET password_hash=EXCLUDED.password_hash,must_change_password=true,
    password_changed_at=now()`,
    [user!.id, administrator.passwordHash],
  );
  return (await findUser(connection, user!.id))!;
}

export async function tokenIdentity(
  connection: Connection,
  tokenHash: string,
): Promise<
  { user: User; token: { id: string; projectId: string | null; scopes: string[] } } | undefined
> {
  const identity = await first<
    User & { tokenId: string; projectId: string | null; scopes: string[] }
  >(
    connection,
    `UPDATE api_tokens t SET last_used_at=now() FROM users u
    WHERE t.token_hash=$1 AND t.user_id=u.id AND u.status='active' AND t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at>now())
    AND (t.project_id IS NULL OR EXISTS(SELECT 1 FROM project_members m WHERE m.project_id=t.project_id AND m.user_id=t.user_id))
    RETURNING ${userColumns},t.id AS token_id,t.project_id,t.scopes`,
    [tokenHash],
  );
  if (!identity) return undefined;
  const { tokenId, projectId, scopes, ...user } = identity;
  return { user, token: { id: tokenId, projectId, scopes } };
}

export async function listMembers(
  connection: Connection,
  projectId: string,
): Promise<(User & { role: string })[]> {
  return rows(
    connection,
    `SELECT ${userColumns},m.role FROM project_members m JOIN users u ON u.id=m.user_id WHERE project_id=$1 ORDER BY u.email`,
    [projectId],
  );
}
