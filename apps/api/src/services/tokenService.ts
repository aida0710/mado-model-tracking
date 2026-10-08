import type { TokenSummary } from '@mmt/contracts';
import type { z } from 'zod';
import type { Principal } from '../auth/principal.js';
import { hashSecret, randomSecret } from '../auth/secrets.js';
import { first, transaction, type Connection, type Database } from '../db/database.js';
import { DomainError, notFound } from '../domain/errors.js';
import { requiredProjectRoleForScopes, resolveTokenExpiry } from '../domain/tokenScopes.js';
import type { tokenCreateSchema } from '../domain/validation.js';
import type { RequestMetadata } from '../http/requestMetadata.js';
import { writeAuditEvent } from '../repositories/auditRepository.js';
import {
  findActiveTokenOwnership,
  insertToken,
  listOwnedTokens,
  listProjectTokens,
  revokeToken,
  type TokenInsert,
} from '../repositories/apiTokenRepository.js';
import { requireProject, requireScope } from './accessService.js';
import {
  auditActor,
  NO_REQUEST_METADATA,
  recordDenial,
  type AuditEventDraft,
} from './auditService.js';

// Long enough to tell tokens apart in a list, far too short to guess the rest of the value.
const TOKEN_PREFIX_LENGTH = 12;

export interface IssuedToken {
  token: string;
  item: TokenSummary;
}

/** Validates the requested expiry against the lifetime limit; no expiry means the limit. */
export function requireTokenExpiry(
  expiresAt: string | null | undefined,
  maxLifetimeDays: number,
): Date {
  const resolution = resolveTokenExpiry({ expiresAt, maxLifetimeDays, now: new Date() });
  if ('expiresAt' in resolution) return resolution.expiresAt;
  if (resolution.error === 'expiry_in_past')
    throw new DomainError(422, 'Tokenの期限は未来の日時を指定してください', 'invalid_expiry');
  throw new DomainError(
    422,
    `Tokenの期限は${maxLifetimeDays}日以内にしてください`,
    'token_lifetime_exceeded',
  );
}

/** Generates a token value and stores only its hash and prefix. The value is returned once. */
export async function issueApiToken(
  connection: Connection,
  token: Omit<TokenInsert, 'tokenHash' | 'tokenPrefix'>,
): Promise<IssuedToken> {
  const value = `mmt_${randomSecret()}`;
  const item = await insertToken(connection, {
    ...token,
    tokenHash: hashSecret(value),
    tokenPrefix: value.slice(0, TOKEN_PREFIX_LENGTH),
  });
  return { token: value, item };
}

/** Audit details of an issued token. The value and its hash never enter the audit log. */
export function tokenCreateAuditDetails(item: TokenSummary) {
  return {
    name: item.name,
    kind: item.kind,
    scopes: item.scopes,
    expiresAt: item.expiresAt,
    ownerType: item.ownerType,
    ownerUserId: item.ownerId,
  };
}

export class TokenService {
  private readonly database: Database;
  private readonly tokenMaxLifetimeDays: number;

  constructor(dependencies: { database: Database; tokenMaxLifetimeDays: number }) {
    this.database = dependencies.database;
    this.tokenMaxLifetimeDays = dependencies.tokenMaxLifetimeDays;
  }

  async list(principal: Principal): Promise<TokenSummary[]> {
    requireScope(principal, 'read');
    return listOwnedTokens(this.database, {
      userId: principal.user.id,
      projectId: principal.token?.projectId ?? null,
    });
  }

  // Values are never returned; administrators see who owns each token and can revoke it.
  async listProject(principal: Principal, projectId: string): Promise<TokenSummary[]> {
    await requireProject(this.database, principal, { projectId, role: 'admin', scope: 'admin' });
    return listProjectTokens(this.database, projectId);
  }

  async create(
    principal: Principal,
    input: z.infer<typeof tokenCreateSchema>,
    request: RequestMetadata = NO_REQUEST_METADATA,
  ): Promise<IssuedToken> {
    const projectId = input.projectId ?? null;
    const draft: AuditEventDraft = {
      ...auditActor(principal),
      ...request,
      action: 'token.create',
      resourceType: 'api_token',
      projectId,
      details: {
        name: input.name,
        kind: input.kind,
        scopes: input.scopes,
        expiresAt: input.expiresAt ?? null,
        ownerType: 'user',
        ownerUserId: principal.user.id,
      },
    };
    return recordDenial(this.database, draft, () =>
      transaction(this.database, async (connection) => {
        await this.requireCreatePermission(connection, principal, input);
        const issued = await issueApiToken(connection, {
          ownerUserId: principal.user.id,
          createdByUserId: principal.user.id,
          projectId,
          name: input.name,
          kind: input.kind,
          scopes: input.scopes,
          expiresAt: requireTokenExpiry(input.expiresAt, this.tokenMaxLifetimeDays),
        });
        await writeAuditEvent(connection, {
          ...draft,
          outcome: 'success',
          resourceId: issued.item.id,
          details: tokenCreateAuditDetails(issued.item),
        });
        return issued;
      }),
    );
  }

  async revoke(
    principal: Principal,
    tokenId: string,
    request: RequestMetadata = NO_REQUEST_METADATA,
  ): Promise<void> {
    const draft: AuditEventDraft = {
      ...auditActor(principal),
      ...request,
      action: 'token.revoke',
      resourceType: 'api_token',
      resourceId: tokenId,
    };
    await recordDenial(this.database, draft, async () => requireSession(principal, 'Tokenの失効'));
    const target = await findActiveTokenOwnership(this.database, tokenId);
    if (!target) notFound('Token');
    const ownerType = target.ownerKind === 'service' ? 'service_account' : 'user';
    // Recorded under the token's Project so its administrators see refused revocations too.
    const projectDraft: AuditEventDraft = {
      ...draft,
      projectId: target.projectId,
      details: { ownerType, ownerUserId: target.ownerUserId },
    };
    await recordDenial(this.database, projectDraft, () =>
      transaction(this.database, async (connection) => {
        if (target.ownerUserId !== principal.user.id) {
          if (!target.projectId)
            throw new DomainError(403, '他の利用者のtokenは変更できません', 'token_forbidden');
          await requireProject(connection, principal, {
            projectId: target.projectId,
            role: 'admin',
            scope: 'admin',
          });
        }
        const revoked = await revokeToken(connection, tokenId);
        // A concurrent revocation won the race; report it the same way as an unknown token.
        if (!revoked) notFound('Token');
        await writeAuditEvent(connection, {
          ...projectDraft,
          outcome: 'success',
          details: { ...projectDraft.details, ...revoked },
        });
      }),
    );
  }

  private async requireCreatePermission(
    connection: Connection,
    principal: Principal,
    input: z.infer<typeof tokenCreateSchema>,
  ): Promise<void> {
    // Minting tokens from a token could extend its expiry and escalate its scope.
    requireSession(principal, 'Tokenの発行');
    const projectId = input.projectId ?? null;
    if ((input.kind === 'service' || input.scopes.includes('worker:execute')) && !projectId)
      throw new DomainError(422, 'Service/worker tokenにはProjectが必要です', 'project_required');
    if (!projectId) {
      if (input.scopes.some((scope) => scope !== 'read') && !principal.user.isAdmin)
        throw new DomainError(403, '書き込みtokenはProjectを指定してください', 'project_required');
      return;
    }
    // A personally owned service token is the legacy form; issuing one still takes an admin.
    const requiredRole =
      input.kind === 'service' ? 'admin' : requiredProjectRoleForScopes(input.scopes);
    await requireProject(connection, principal, { projectId, role: requiredRole, scope: 'admin' });
    // Unlike session administration, token membership (direct or through a group) is mandatory.
    const membership = await first(
      connection,
      'SELECT role FROM effective_project_roles WHERE project_id=$1 AND user_id=$2',
      [projectId, principal.user.id],
    );
    if (!membership)
      throw new DomainError(
        403,
        'Tokenの所有者はProjectのメンバーである必要があります',
        'membership_required',
      );
  }
}

export function requireSession(principal: Principal, operation: string): void {
  if (principal.method !== 'session')
    throw new DomainError(403, `${operation}にはブラウザでのloginが必要です`, 'session_required');
}
