import type { ProjectRole, ServiceAccount } from '@mmt/contracts';
import { first, rows, type Connection } from '../db/database.js';

const serviceAccountSelect = `SELECT u.id,d.project_id,u.display_name AS name,d.description,m.role,
  u.status,u.created_at
  FROM service_account_details d JOIN users u ON u.id=d.user_id
  LEFT JOIN project_members m ON m.project_id=d.project_id AND m.user_id=u.id`;

export async function listServiceAccounts(
  connection: Connection,
  projectId: string,
): Promise<ServiceAccount[]> {
  return rows<ServiceAccount>(
    connection,
    `${serviceAccountSelect} WHERE d.project_id=$1 ORDER BY lower(u.display_name),u.id`,
    [projectId],
  );
}

export async function findServiceAccount(
  connection: Connection,
  account: { projectId: string; serviceAccountId: string },
): Promise<ServiceAccount | undefined> {
  return first<ServiceAccount>(
    connection,
    `${serviceAccountSelect} WHERE d.project_id=$1 AND d.user_id=$2`,
    [account.projectId, account.serviceAccountId],
  );
}

/** Locks the account's user row so status changes and token issuance serialize. */
export async function lockServiceAccount(
  connection: Connection,
  account: { projectId: string; serviceAccountId: string },
): Promise<ServiceAccount | undefined> {
  const locked = await first(
    connection,
    `SELECT u.id FROM users u JOIN service_account_details d ON d.user_id=u.id
    WHERE d.project_id=$1 AND u.id=$2 FOR UPDATE OF u`,
    [account.projectId, account.serviceAccountId],
  );
  return locked ? findServiceAccount(connection, account) : undefined;
}

// A users row without email or login method; the name is its display name.
export async function insertServiceAccount(
  connection: Connection,
  account: {
    projectId: string;
    name: string;
    description: string;
    role: ProjectRole;
    createdBy: string;
  },
): Promise<ServiceAccount> {
  const user = await first<{ id: string }>(
    connection,
    `INSERT INTO users(email,display_name,kind,service_project_id) VALUES('',$1,'service',$2) RETURNING id`,
    [account.name, account.projectId],
  );
  const serviceAccountId = user!.id;
  await connection.query(
    'INSERT INTO service_account_details(user_id,project_id,description,created_by) VALUES($1,$2,$3,$4)',
    [serviceAccountId, account.projectId, account.description, account.createdBy],
  );
  await connection.query('INSERT INTO project_members(project_id,user_id,role) VALUES($1,$2,$3)', [
    account.projectId,
    serviceAccountId,
    account.role,
  ]);
  return (await findServiceAccount(connection, {
    projectId: account.projectId,
    serviceAccountId,
  }))!;
}

export async function updateServiceAccountDescription(
  connection: Connection,
  account: { serviceAccountId: string; description: string },
): Promise<void> {
  await connection.query('UPDATE service_account_details SET description=$2 WHERE user_id=$1', [
    account.serviceAccountId,
    account.description,
  ]);
}

// users.status is what authentication reads, so disabling takes effect on the next request.
export async function setServiceAccountStatus(
  connection: Connection,
  account: { serviceAccountId: string; status: ServiceAccount['status'] },
): Promise<void> {
  await connection.query('UPDATE users SET status=$2,updated_at=now() WHERE id=$1', [
    account.serviceAccountId,
    account.status,
  ]);
  if (account.status === 'disabled')
    await connection.query(
      'UPDATE service_account_details SET disabled_at=now() WHERE user_id=$1',
      [account.serviceAccountId],
    );
}

export async function setServiceAccountRole(
  connection: Connection,
  account: { projectId: string; serviceAccountId: string; role: ProjectRole },
): Promise<void> {
  await connection.query(
    `INSERT INTO project_members(project_id,user_id,role) VALUES($1,$2,$3)
    ON CONFLICT(project_id,user_id) DO UPDATE SET role=EXCLUDED.role`,
    [account.projectId, account.serviceAccountId, account.role],
  );
}
