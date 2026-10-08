import type { TokenSummary } from '@mmt/contracts';
import type { z } from 'zod';
import type { Principal } from '../auth/principal.js';
import { hashSecret, randomSecret } from '../auth/secrets.js';
import { first, rows, transaction, type Connection, type Database } from '../db/database.js';
import { DomainError, notFound } from '../domain/errors.js';
import type { tokenCreateSchema } from '../domain/validation.js';
import type { RequestMetadata } from '../http/requestMetadata.js';
import { writeAuditEvent } from '../repositories/auditRepository.js';
import { tokenColumns } from '../repositories/identityRepository.js';
import { requireProject, requireScope } from './accessService.js';
import {
  auditActor,
  NO_REQUEST_METADATA,
  recordDenial,
  type AuditEventDraft,
} from './auditService.js';

export class TokenService {
  constructor(private readonly database: Database) {}

  async list(principal: Principal): Promise<TokenSummary[]> {
    requireScope(principal, 'read');
    return rows(
      this.database,
      `SELECT ${tokenColumns} FROM api_tokens WHERE user_id=$1 AND revoked_at IS NULL AND ($2::uuid IS NULL OR project_id=$2) ORDER BY created_at DESC`,
      [principal.user.id, principal.token?.projectId ?? null],
    );
  }

  async create(
    principal: Principal,
    input: z.infer<typeof tokenCreateSchema>,
    request: RequestMetadata = NO_REQUEST_METADATA,
  ): Promise<{ token: string; item: TokenSummary }> {
    const projectId = input.projectId ?? null;
    // The token value and its hash never enter the audit log.
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
      },
    };
    return recordDenial(this.database, draft, () =>
      transaction(this.database, async (connection) => {
        await this.requireCreatePermission(connection, principal, input);
        const token = `mmt_${randomSecret()}`;
        const item = (await first<TokenSummary>(
          connection,
          `INSERT INTO api_tokens(user_id,project_id,name,kind,token_hash,scopes,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING ${tokenColumns}`,
          [
            principal.user.id,
            projectId,
            input.name,
            input.kind,
            hashSecret(token),
            input.scopes,
            input.expiresAt ?? null,
          ],
        ))!;
        await writeAuditEvent(connection, { ...draft, outcome: 'success', resourceId: item.id });
        return { token, item };
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
    const target = await first<{ userId: string; projectId: string | null }>(
      this.database,
      'SELECT user_id,project_id FROM api_tokens WHERE id=$1 AND revoked_at IS NULL',
      [tokenId],
    );
    if (!target) notFound('Token');
    // Recorded under the token's Project so its administrators see refused revocations too.
    const projectDraft: AuditEventDraft = { ...draft, projectId: target.projectId };
    await recordDenial(this.database, projectDraft, () =>
      transaction(this.database, async (connection) => {
        if (target.userId !== principal.user.id) {
          if (!target.projectId)
            throw new DomainError(403, '他の利用者のtokenは変更できません', 'token_forbidden');
          await requireProject(connection, principal, {
            projectId: target.projectId,
            role: 'admin',
            scope: 'admin',
          });
        }
        const revoked = await first<{ name: string; kind: string; scopes: string[] }>(
          connection,
          'UPDATE api_tokens SET revoked_at=now() WHERE id=$1 AND revoked_at IS NULL RETURNING name,kind,scopes',
          [tokenId],
        );
        // A concurrent revocation won the race; report it the same way as an unknown token.
        if (!revoked) notFound('Token');
        await writeAuditEvent(connection, {
          ...projectDraft,
          outcome: 'success',
          details: { ownerUserId: target.userId, ...revoked },
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
    if (input.expiresAt && new Date(input.expiresAt) <= new Date())
      throw new DomainError(422, 'Tokenの期限は未来の日時を指定してください', 'invalid_expiry');
    const projectId = input.projectId ?? null;
    if ((input.kind === 'service' || input.scopes.includes('worker:execute')) && !projectId)
      throw new DomainError(422, 'Service/worker tokenにはProjectが必要です', 'project_required');
    if (!projectId) {
      if (input.scopes.some((scope) => scope !== 'read') && !principal.user.isAdmin)
        throw new DomainError(403, '書き込みtokenはProjectを指定してください', 'project_required');
      return;
    }
    const needsAdmin =
      input.kind === 'service' ||
      input.scopes.includes('admin') ||
      input.scopes.includes('worker:execute');
    const writes = input.scopes.some((scope) => scope !== 'read');
    await requireProject(connection, principal, {
      projectId,
      role: needsAdmin ? 'admin' : writes ? 'editor' : 'viewer',
      scope: 'admin',
    });
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

function requireSession(principal: Principal, operation: string): void {
  if (principal.method !== 'session')
    throw new DomainError(403, `${operation}にはブラウザでのloginが必要です`, 'session_required');
}
