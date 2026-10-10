import type { Launcher } from '@mmt/contracts';
import { hashSecret, randomSecret } from '../auth/secrets.js';
import { first, rows, type Connection } from '../db/database.js';

// The scope only launcher tokens carry; personal and Service Account tokens cannot ask for it.
export const LAUNCHER_SCOPE = 'launcher:execute';
// Like other API tokens (tokenService): `mmt_` and a random secret; the first characters are kept.
const LAUNCHER_TOKEN_PREFIX_LENGTH = 12;

const launcherColumns = `l.id,l.name,l.created_by,l.created_at,l.last_seen_at,l.revoked_at,
  (SELECT t.token_prefix FROM api_tokens t WHERE t.user_id=l.user_id AND t.revoked_at IS NULL
    ORDER BY t.created_at DESC LIMIT 1) AS token_prefix`;

export async function listLaunchers(
  connection: Connection,
  options: { includeRevoked: boolean },
): Promise<Launcher[]> {
  return rows<Launcher>(
    connection,
    `SELECT ${launcherColumns} FROM launchers l WHERE $1::boolean OR l.revoked_at IS NULL
    ORDER BY lower(l.name),l.id`,
    [options.includeRevoked],
  );
}

export async function findLauncher(
  connection: Connection,
  launcherId: string,
): Promise<(Launcher & { userId: string }) | undefined> {
  return first<Launcher & { userId: string }>(
    connection,
    `SELECT l.user_id,${launcherColumns} FROM launchers l WHERE l.id=$1`,
    [launcherId],
  );
}

export async function isLiveLauncher(connection: Connection, launcherId: string): Promise<boolean> {
  return !!(await first(connection, 'SELECT 1 FROM launchers WHERE id=$1 AND revoked_at IS NULL', [
    launcherId,
  ]));
}

/** The launcher's own user owns its token, so the token survives the administrator leaving. */
export async function insertLauncher(
  connection: Connection,
  launcher: { name: string; createdBy: string },
): Promise<string> {
  const user = (await first<{ id: string }>(
    connection,
    "INSERT INTO users(email,display_name,kind) VALUES('',$1,'launcher') RETURNING id",
    [launcher.name],
  ))!;
  return (await first<{ id: string }>(
    connection,
    'INSERT INTO launchers(user_id,name,created_by) VALUES($1,$2,$3) RETURNING id',
    [user.id, launcher.name, launcher.createdBy],
  ))!.id;
}

/** Revokes the launcher's tokens and issues a new one; the value is returned once. */
export async function replaceLauncherToken(
  connection: Connection,
  launcher: { userId: string; createdBy: string },
): Promise<string> {
  await revokeLauncherTokens(connection, launcher.userId);
  const value = `mmt_${randomSecret()}`;
  await connection.query(
    `INSERT INTO api_tokens(user_id,created_by_user_id,project_id,name,kind,token_hash,token_prefix,scopes)
    VALUES($1,$2,NULL,'launcher','launcher',$3,$4,$5)`,
    [
      launcher.userId,
      launcher.createdBy,
      hashSecret(value),
      value.slice(0, LAUNCHER_TOKEN_PREFIX_LENGTH),
      [LAUNCHER_SCOPE],
    ],
  );
  return value;
}

export async function revokeLauncherTokens(connection: Connection, userId: string): Promise<void> {
  await connection.query(
    'UPDATE api_tokens SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL',
    [userId],
  );
}

export async function revokeLauncher(connection: Connection, launcherId: string): Promise<void> {
  const launcher = (await first<{ userId: string }>(
    connection,
    'UPDATE launchers SET revoked_at=now() WHERE id=$1 RETURNING user_id',
    [launcherId],
  ))!;
  await revokeLauncherTokens(connection, launcher.userId);
  await connection.query("UPDATE users SET status='disabled' WHERE id=$1", [launcher.userId]);
}

/** The live launcher a token's user is. */
export async function findLauncherByUser(
  connection: Connection,
  userId: string,
): Promise<{ id: string; name: string } | undefined> {
  return first(
    connection,
    'SELECT id,name FROM launchers WHERE user_id=$1 AND revoked_at IS NULL',
    [userId],
  );
}

export async function touchLauncher(connection: Connection, launcherId: string): Promise<void> {
  await connection.query('UPDATE launchers SET last_seen_at=now() WHERE id=$1', [launcherId]);
}
