import type { User } from '@mmt/contracts';
import { first, rows, type Connection } from '../db/database.js';

// username/status/auth_sources are derived until migration 010 stores local account columns.
export const userColumns = `u.id,u.email,u.display_name,u.is_admin,NULL::text AS username,
  'active' AS status,CASE WHEN u.issuer='development' THEN ARRAY[]::text[] ELSE ARRAY['oidc'] END AS auth_sources`;
export const tokenColumns = 'id,name,kind,project_id,scopes,expires_at,last_used_at,created_at';

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

export async function sessionUser(
  connection: Connection,
  tokenHash: string,
): Promise<User | undefined> {
  return first<User>(
    connection,
    `SELECT ${userColumns} FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now()`,
    [tokenHash],
  );
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
    WHERE t.token_hash=$1 AND t.user_id=u.id AND t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at>now())
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
