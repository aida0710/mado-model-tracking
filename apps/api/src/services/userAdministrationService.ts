import { randomBytes } from 'node:crypto';
import type { AdminUser, AdminUserPasswordReset, AdminUserQuery } from '@mmt/contracts';
import type { Principal } from '../auth/principal.js';
import { isAcceptablePasswordLength, type PasswordHasher } from '../auth/passwordHasher.js';
import { transaction, type Database } from '../db/database.js';
import {
  ADMIN_USER_LIST_LIMIT,
  type AdminUserCreateInput,
  type AdminUserPatchInput,
} from '../domain/adminUserValidation.js';
import { DomainError, notFound } from '../domain/errors.js';
import { removesLastGlobalAdmin } from '../domain/globalAdminInvariant.js';
import type { RequestMetadata } from '../http/requestMetadata.js';
import { writeAuditEvent } from '../repositories/auditRepository.js';
import { lockActiveGlobalAdminIds } from '../repositories/identityRepository.js';
import { revokeAllForUser } from '../repositories/sessionRepository.js';
import { setServiceAccountStatus } from '../repositories/serviceAccountRepository.js';
import {
  findAdminUser,
  insertLocalUser,
  isUsernameTaken,
  listAdminUsers,
  lockAdminUser,
  resetLocalPassword,
  updateAdminUser,
} from '../repositories/userAdministrationRepository.js';
import { requireGlobalAdmin } from './accessService.js';
import {
  auditActor,
  NO_REQUEST_METADATA,
  recordDenial,
  type AuditEventDraft,
} from './auditService.js';

// 18 random bytes encode to 24 base64url characters, well above the 12-byte minimum.
const TEMPORARY_PASSWORD_BYTES = 18;

// Account management changes who can sign in, so it is not exposed to API tokens at all.
function requireAdministratorSession(principal: Principal): void {
  if (principal.method !== 'session')
    throw new DomainError(403, 'ユーザー管理にはブラウザでのloginが必要です', 'session_required');
  requireGlobalAdmin(principal);
}

// SSO users get their global role and display name from the IdP at every login.
function isSsoUser(user: AdminUser): boolean {
  return user.authSources.includes('oidc');
}

/** The global administrator's user management: local accounts, disabling and password resets. */
export class UserAdministrationService {
  constructor(
    private readonly options: { database: Database; passwordHasher: PasswordHasher },
  ) {}

  async list(principal: Principal, query: AdminUserQuery): Promise<AdminUser[]> {
    requireAdministratorSession(principal);
    return listAdminUsers(this.options.database, { ...query, limit: ADMIN_USER_LIST_LIMIT });
  }

  async create(
    principal: Principal,
    input: AdminUserCreateInput,
    request: RequestMetadata = NO_REQUEST_METADATA,
  ): Promise<AdminUser> {
    // The temporary password never enters the audit log.
    const draft = this.auditDraft(principal, request, 'admin.user.create', null, {
      username: input.username,
      isAdmin: input.isAdmin,
    });
    return recordDenial(this.options.database, draft, async () => {
      requireAdministratorSession(principal);
      const passwordHash = await this.hashTemporaryPassword(input.password);
      return transaction(this.options.database, async (connection) => {
        if (await isUsernameTaken(connection, input.username))
          throw new DomainError(409, '同じユーザー名が既にあります', 'username_taken');
        const userId = await insertLocalUser(connection, {
          username: input.username,
          displayName: input.displayName,
          email: input.email ?? '',
          isAdmin: input.isAdmin,
          passwordHash,
        });
        await writeAuditEvent(connection, { ...draft, outcome: 'success', resourceId: userId });
        return (await findAdminUser(connection, userId))!;
      });
    });
  }

  async update(
    principal: Principal,
    userId: string,
    patch: AdminUserPatchInput,
    request: RequestMetadata = NO_REQUEST_METADATA,
  ): Promise<AdminUser> {
    const draft = this.auditDraft(principal, request, 'admin.user.update', userId, {
      changedFields: Object.keys(patch).sort(),
    });
    return recordDenial(this.options.database, draft, async () => {
      requireAdministratorSession(principal);
      return transaction(this.options.database, async (connection) => {
        const current = await lockAdminUser(connection, userId);
        if (!current) notFound('User');
        const next = {
          status: patch.status ?? current.status,
          displayName: patch.displayName ?? current.displayName,
          isAdmin: patch.isAdmin ?? current.isAdmin,
        };
        this.validateChange(current, next);
        // Order from the global admin invariant: the user's row first, then the admin lock.
        const activeAdminIds = await lockActiveGlobalAdminIds(connection);
        if (removesLastGlobalAdmin(activeAdminIds, { userId, ...next }))
          throw new DomainError(
            409,
            '最後の有効な全体管理者は無効化・降格できません',
            'last_global_admin',
          );
        await updateAdminUser(connection, { userId, ...next });
        // A Service Account disabled here reads the same as one disabled from Project settings.
        if (current.kind === 'service' && next.status !== current.status)
          await setServiceAccountStatus(connection, { serviceAccountId: userId, status: next.status });
        // Tokens stop through the users.status check; sessions are revoked so they do not return.
        if (next.status === 'disabled' && current.status !== 'disabled')
          await revokeAllForUser(connection, userId);
        await writeAuditEvent(connection, {
          ...draft,
          outcome: 'success',
          details: {
            ...draft.details,
            before: {
              status: current.status,
              isAdmin: current.isAdmin,
              displayName: current.displayName,
            },
            after: next,
          },
        });
        return (await findAdminUser(connection, userId))!;
      });
    });
  }

  async resetPassword(
    principal: Principal,
    userId: string,
    request: RequestMetadata = NO_REQUEST_METADATA,
  ): Promise<AdminUserPasswordReset> {
    const draft = this.auditDraft(principal, request, 'admin.user.password_reset', userId, {});
    return recordDenial(this.options.database, draft, async () => {
      requireAdministratorSession(principal);
      const temporaryPassword = randomBytes(TEMPORARY_PASSWORD_BYTES).toString('base64url');
      const passwordHash = await this.options.passwordHasher.hash(temporaryPassword);
      await transaction(this.options.database, async (connection) => {
        const user = await lockAdminUser(connection, userId);
        if (!user) notFound('User');
        if (!(await resetLocalPassword(connection, { userId, passwordHash })))
          throw new DomainError(
            422,
            'ローカルアカウントを持たないユーザーのパスワードは再設定できません',
            'local_account_required',
          );
        await revokeAllForUser(connection, userId);
        await writeAuditEvent(connection, { ...draft, outcome: 'success' });
      });
      return { temporaryPassword };
    });
  }

  private validateChange(
    current: AdminUser,
    next: Pick<AdminUser, 'status' | 'displayName' | 'isAdmin'>,
  ): void {
    if (isSsoUser(current) && next.isAdmin !== current.isAdmin)
      throw new DomainError(
        422,
        'SSOユーザーの全体管理者権限はAuthentikのgroupで決まるため変更できません',
        'admin_role_managed_by_sso',
      );
    if (isSsoUser(current) && next.displayName !== current.displayName)
      throw new DomainError(
        422,
        'SSOユーザーの表示名はAuthentikから同期されるため変更できません',
        'profile_managed_by_sso',
      );
    if (current.kind === 'service' && next.isAdmin)
      throw new DomainError(
        422,
        'Service Accountは全体管理者にできません',
        'service_account_admin_forbidden',
      );
  }

  private async hashTemporaryPassword(password: string): Promise<string> {
    if (!isAcceptablePasswordLength(password))
      throw new DomainError(
        422,
        '初回パスワードは12〜1024 byteにしてください',
        'weak_password',
      );
    return this.options.passwordHasher.hash(password);
  }

  private auditDraft(
    principal: Principal,
    request: RequestMetadata,
    action: string,
    userId: string | null,
    details: AuditEventDraft['details'],
  ): AuditEventDraft {
    return {
      ...auditActor(principal),
      ...request,
      action,
      resourceType: 'user',
      resourceId: userId,
      details,
    };
  }
}
