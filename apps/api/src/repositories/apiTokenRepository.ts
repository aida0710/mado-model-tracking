import type { TokenSummary } from '@mmt/contracts';
import { first, rows, type Connection } from '../db/database.js';

// Who owns a token decides how it is shown: a Service Account, or a person. A service token
// owned by a person is the form used before Service Accounts existed.
const tokenSummarySelect = `SELECT t.id,t.name,t.kind,t.project_id,t.scopes,t.expires_at,t.last_used_at,
  t.created_at,CASE WHEN o.kind='service' THEN 'service_account' ELSE 'user' END AS owner_type,
  o.id AS owner_id,o.display_name AS owner_name,t.token_prefix,
  (t.kind='service' AND o.kind='human') AS legacy
  FROM api_tokens t JOIN users o ON o.id=t.user_id`;

export interface TokenInsert {
  ownerUserId: string;
  createdByUserId: string;
  projectId: string | null;
  name: string;
  kind: TokenSummary['kind'];
  tokenHash: string;
  tokenPrefix: string;
  scopes: string[];
  expiresAt: Date;
}

export interface TokenOwnership {
  ownerUserId: string;
  ownerKind: 'human' | 'service';
  projectId: string | null;
}

export async function insertToken(
  connection: Connection,
  token: TokenInsert,
): Promise<TokenSummary> {
  const inserted = await first<{ id: string }>(
    connection,
    `INSERT INTO api_tokens(user_id,created_by_user_id,project_id,name,kind,token_hash,token_prefix,scopes,expires_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [
      token.ownerUserId,
      token.createdByUserId,
      token.projectId,
      token.name,
      token.kind,
      token.tokenHash,
      token.tokenPrefix,
      token.scopes,
      token.expiresAt,
    ],
  );
  return (await findTokenSummary(connection, inserted!.id))!;
}

export async function findTokenSummary(
  connection: Connection,
  tokenId: string,
): Promise<TokenSummary | undefined> {
  return first<TokenSummary>(connection, `${tokenSummarySelect} WHERE t.id=$1`, [tokenId]);
}

/** Unrevoked tokens the user owns; projectId narrows them to one Project. */
export async function listOwnedTokens(
  connection: Connection,
  owner: { userId: string; projectId: string | null },
): Promise<TokenSummary[]> {
  return rows<TokenSummary>(
    connection,
    `${tokenSummarySelect} WHERE t.user_id=$1 AND t.revoked_at IS NULL
    AND ($2::uuid IS NULL OR t.project_id=$2) ORDER BY t.created_at DESC,t.id`,
    [owner.userId, owner.projectId],
  );
}

/** Every unrevoked token limited to the Project, whoever owns it. */
export async function listProjectTokens(
  connection: Connection,
  projectId: string,
): Promise<TokenSummary[]> {
  return rows<TokenSummary>(
    connection,
    `${tokenSummarySelect} WHERE t.project_id=$1 AND t.revoked_at IS NULL
    ORDER BY t.created_at DESC,t.id`,
    [projectId],
  );
}

export async function findActiveTokenOwnership(
  connection: Connection,
  tokenId: string,
): Promise<TokenOwnership | undefined> {
  return first<TokenOwnership>(
    connection,
    `SELECT t.user_id AS owner_user_id,o.kind AS owner_kind,t.project_id
    FROM api_tokens t JOIN users o ON o.id=t.user_id WHERE t.id=$1 AND t.revoked_at IS NULL`,
    [tokenId],
  );
}

/** Returns what the audit record needs, or undefined when another request revoked it first. */
export async function revokeToken(
  connection: Connection,
  tokenId: string,
): Promise<{ name: string; kind: string; scopes: string[] } | undefined> {
  return first(
    connection,
    'UPDATE api_tokens SET revoked_at=now() WHERE id=$1 AND revoked_at IS NULL RETURNING name,kind,scopes',
    [tokenId],
  );
}
