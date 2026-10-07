import type { TokenSummary } from '@mmt/contracts';
import type { z } from 'zod';
import type { Principal } from '../auth/principal.js';
import { hashSecret, randomSecret } from '../auth/secrets.js';
import { first, rows, type Database } from '../db/database.js';
import { DomainError, notFound } from '../domain/errors.js';
import type { tokenCreateSchema } from '../domain/validation.js';
import { tokenColumns } from '../repositories/identityRepository.js';
import { requireProject, requireScope } from './accessService.js';

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
  ): Promise<{ token: string; item: TokenSummary }> {
    // Minting tokens from a token could extend its expiry and escalate its scope.
    if (principal.method !== 'session')
      throw new DomainError(403, 'Tokenの発行にはブラウザでのloginが必要です', 'session_required');
    if (input.expiresAt && new Date(input.expiresAt) <= new Date())
      throw new DomainError(422, 'Tokenの期限は未来の日時を指定してください', 'invalid_expiry');
    const projectId = input.projectId ?? null;
    if ((input.kind === 'service' || input.scopes.includes('worker:execute')) && !projectId)
      throw new DomainError(422, 'Service/worker tokenにはProjectが必要です', 'project_required');
    if (projectId) {
      const needsAdmin =
        input.kind === 'service' ||
        input.scopes.includes('admin') ||
        input.scopes.includes('worker:execute');
      const writes = input.scopes.some((scope) => scope !== 'read');
      await requireProject(this.database, principal, {
        projectId,
        role: needsAdmin ? 'admin' : writes ? 'editor' : 'viewer',
        scope: 'admin',
      });
      // Unlike session administration, token membership is mandatory.
      const membership = await first(
        this.database,
        'SELECT role FROM project_members WHERE project_id=$1 AND user_id=$2',
        [projectId, principal.user.id],
      );
      if (!membership)
        throw new DomainError(
          403,
          'Tokenの所有者はProjectのメンバーである必要があります',
          'membership_required',
        );
    } else if (input.scopes.some((scope) => scope !== 'read') && !principal.user.isAdmin) {
      throw new DomainError(403, '書き込みtokenはProjectを指定してください', 'project_required');
    }
    const token = `mmt_${randomSecret()}`;
    const item = await first<TokenSummary>(
      this.database,
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
    );
    return { token, item: item! };
  }

  async revoke(principal: Principal, tokenId: string): Promise<void> {
    if (principal.method !== 'session')
      throw new DomainError(403, 'Tokenの失効にはブラウザでのloginが必要です', 'session_required');
    const token = await first<{ userId: string; projectId: string | null }>(
      this.database,
      'SELECT user_id,project_id FROM api_tokens WHERE id=$1 AND revoked_at IS NULL',
      [tokenId],
    );
    if (!token) notFound('Token');
    if (token.userId !== principal.user.id) {
      if (!token.projectId)
        throw new DomainError(403, '他の利用者のtokenは変更できません', 'token_forbidden');
      await requireProject(this.database, principal, {
        projectId: token.projectId,
        role: 'admin',
        scope: 'admin',
      });
    }
    await this.database.query('UPDATE api_tokens SET revoked_at=now() WHERE id=$1', [tokenId]);
  }
}
