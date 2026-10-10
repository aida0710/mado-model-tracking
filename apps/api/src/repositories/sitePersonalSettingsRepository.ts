import type { SiteKey, SitePersonalSettings } from '@mmt/contracts';
import { first, rows, type Connection } from '../db/database.js';
import { findLiveSiteKey, listLiveSiteKeys } from './siteKeyRepository.js';

type PersonalSettingsRow = Omit<SitePersonalSettings, 'key'>;

const personalSelect = `SELECT p.target_id,p.user_id,u.display_name AS user_name,p.account_name,
  p.work_directory,p.variables,p.updated_at
  FROM site_personal_settings p JOIN users u ON u.id=p.user_id`;

export async function findPersonalSettings(
  connection: Connection,
  owner: { targetId: string; userId: string },
): Promise<SitePersonalSettings | undefined> {
  const found = await first<PersonalSettingsRow>(
    connection,
    `${personalSelect} WHERE p.target_id=$1 AND p.user_id=$2`,
    [owner.targetId, owner.userId],
  );
  if (!found) return undefined;
  return { ...found, key: (await findLiveSiteKey(connection, owner)) ?? null };
}

/** Everyone's settings for the site, for its owner and global administrators. */
export async function listPersonalSettings(
  connection: Connection,
  targetId: string,
): Promise<SitePersonalSettings[]> {
  const found = await rows<PersonalSettingsRow>(
    connection,
    `${personalSelect} WHERE p.target_id=$1 ORDER BY u.display_name,p.user_id`,
    [targetId],
  );
  const keys = new Map<string, SiteKey>();
  for (const key of await listLiveSiteKeys(connection, targetId))
    if (key.userId) keys.set(key.userId, key);
  return found.map((settings) => ({ ...settings, key: keys.get(settings.userId) ?? null }));
}

export async function savePersonalSettings(
  connection: Connection,
  settings: {
    targetId: string;
    userId: string;
    accountName: string;
    workDirectory: string | null;
    variables: Record<string, string>;
  },
): Promise<void> {
  await connection.query(
    `INSERT INTO site_personal_settings(target_id,user_id,account_name,work_directory,variables)
    VALUES($1,$2,$3,$4,$5::jsonb)
    ON CONFLICT (target_id,user_id) DO UPDATE SET account_name=$3,work_directory=$4,variables=$5::jsonb,
      updated_at=now()`,
    [
      settings.targetId,
      settings.userId,
      settings.accountName,
      settings.workDirectory,
      JSON.stringify(settings.variables),
    ],
  );
}

export async function deletePersonalSettings(
  connection: Connection,
  owner: { targetId: string; userId: string },
): Promise<boolean> {
  const deleted = await connection.query(
    'DELETE FROM site_personal_settings WHERE target_id=$1 AND user_id=$2',
    [owner.targetId, owner.userId],
  );
  return (deleted.rowCount ?? 0) > 0;
}
