import type { User } from '@mmt/contracts';
import type { ApiConfig } from '../config.js';
import { transaction, type Database } from '../db/database.js';
import { DomainError } from '../domain/errors.js';
import { randomSecret } from '../auth/secrets.js';
import type { Principal } from '../auth/principal.js';
import {
  CURRENT_PASSWORD_LIMIT,
  LOCAL_LOGIN_IP_LIMIT,
  LOCAL_LOGIN_USERNAME_FAILURE_LIMIT,
  type AuthRateLimiter,
} from '../auth/authRateLimiter.js';
import { isAcceptablePasswordLength, type PasswordHasher } from '../auth/passwordHasher.js';
import {
  findLocalCredential,
  findLocalCredentialByUsername,
  recordLogin,
  rehashLocalPassword,
  replaceLocalPassword,
  findUser,
} from '../repositories/identityRepository.js';
import { createSession, revokeOtherSessions } from '../repositories/sessionRepository.js';
import { writeAuditEvent } from '../repositories/auditRepository.js';
import type { RequestMetadata } from '../http/requestMetadata.js';
import { loginAudit } from '../auth/authAuditEvents.js';

export interface LocalLogin {
  user: User;
  session: string;
  mustChangePassword: boolean;
}

// One body for unknown users, wrong passwords, and disabled users so responses reveal nothing.
function invalidCredentials(): DomainError {
  return new DomainError(
    401,
    'ユーザー名またはパスワードが正しくありません',
    'invalid_credentials',
  );
}

export class LocalAuthService {
  private readonly database: Database;
  private readonly config: ApiConfig;
  private readonly rateLimiter: AuthRateLimiter;
  private readonly passwordHasher: PasswordHasher;
  // Verifying against this hash when the user is unknown keeps response times alike.
  private dummyPasswordHash: Promise<string> | undefined;

  constructor(dependencies: {
    database: Database;
    config: ApiConfig;
    rateLimiter: AuthRateLimiter;
    passwordHasher: PasswordHasher;
  }) {
    this.database = dependencies.database;
    this.config = dependencies.config;
    this.rateLimiter = dependencies.rateLimiter;
    this.passwordHasher = dependencies.passwordHasher;
  }

  async login(
    input: { username: string; password: string },
    metadata: RequestMetadata,
  ): Promise<LocalLogin> {
    if (!this.config.localLoginEnabled)
      throw new DomainError(404, 'ローカルアカウントのloginは無効です', 'local_login_disabled');
    const username = input.username.trim().toLowerCase();
    const usernameKey = `local-login:username:${username}`;
    this.rateLimiter.consumeOrThrow(
      `local-login:ip:${metadata.ip ?? 'unknown'}`,
      LOCAL_LOGIN_IP_LIMIT,
    );
    this.rateLimiter.checkOrThrow(usernameKey, LOCAL_LOGIN_USERNAME_FAILURE_LIMIT);
    const credential = await findLocalCredentialByUsername(this.database, username);
    const isPasswordValid = await this.rateLimiter.passwordCheck(async () =>
      this.passwordHasher.verify(
        credential?.passwordHash ?? (await this.dummyHash()),
        input.password,
      ),
    );
    // A Service Account acts only through its tokens, even if a password row was added to it.
    if (
      !credential ||
      !isPasswordValid ||
      credential.status !== 'active' ||
      credential.kind !== 'human'
    ) {
      this.rateLimiter.record(usernameKey, LOCAL_LOGIN_USERNAME_FAILURE_LIMIT);
      await writeAuditEvent(this.database, {
        ...loginAudit('local', metadata),
        actorType: 'system',
        outcome: 'failed',
        resourceId: credential?.userId ?? null,
        details: { method: 'local', username },
      });
      throw invalidCredentials();
    }
    const rehashedPasswordHash = this.passwordHasher.needsRehash(credential.passwordHash)
      ? await this.rateLimiter.passwordCheck(() => this.passwordHasher.hash(input.password))
      : undefined;
    return transaction(this.database, async (connection) => {
      // A password changed during verification must not open a session with the old one.
      const current = await findLocalCredential(connection, credential.userId);
      if (current?.passwordHash !== credential.passwordHash || current.status !== 'active')
        throw invalidCredentials();
      if (rehashedPasswordHash)
        await rehashLocalPassword(connection, {
          userId: credential.userId,
          verifiedPasswordHash: credential.passwordHash,
          newPasswordHash: rehashedPasswordHash,
        });
      await recordLogin(connection, credential.userId);
      const session = await createSession(connection, {
        userId: credential.userId,
        authMethod: 'local',
        absoluteSeconds: this.config.session.absoluteSeconds,
      });
      await writeAuditEvent(connection, {
        ...loginAudit('local', metadata),
        actorType: 'user',
        actorUserId: credential.userId,
        outcome: 'success',
        resourceId: credential.userId,
        details: { method: 'local', username },
      });
      const user = (await findUser(connection, credential.userId))!;
      return { user, session, mustChangePassword: current.mustChangePassword };
    });
  }

  // Keeps the calling session and revokes the user's other sessions.
  async changePassword(
    principal: Principal,
    input: { currentPassword: string; newPassword: string },
    metadata: RequestMetadata,
  ): Promise<void> {
    if (!principal.session)
      throw new DomainError(403, 'パスワードの変更にはloginが必要です', 'session_required');
    const userId = principal.user.id;
    const credential = await findLocalCredential(this.database, userId);
    if (!credential)
      throw new DomainError(
        403,
        'ローカルアカウントを持たないユーザーです',
        'local_account_required',
      );
    if (
      !isAcceptablePasswordLength(input.newPassword) ||
      input.newPassword === input.currentPassword
    )
      throw new DomainError(
        422,
        '新しいパスワードは現在と異なる12〜1024 byteにしてください',
        'weak_password',
      );
    this.rateLimiter.consumeOrThrow(`current-password:user:${userId}`, CURRENT_PASSWORD_LIMIT);
    const newPasswordHash = await this.rateLimiter.passwordCheck(async () =>
      (await this.passwordHasher.verify(credential.passwordHash, input.currentPassword))
        ? this.passwordHasher.hash(input.newPassword)
        : undefined,
    );
    const changeAudit = {
      actorType: 'user' as const,
      actorUserId: userId,
      action: 'auth.password.change',
      resourceType: 'user',
      resourceId: userId,
      ...metadata,
    };
    if (!newPasswordHash) {
      await writeAuditEvent(this.database, { ...changeAudit, outcome: 'failed' });
      throw new DomainError(401, '現在のパスワードが正しくありません', 'invalid_credentials');
    }
    await transaction(this.database, async (connection) => {
      const isReplaced = await replaceLocalPassword(connection, {
        userId,
        verifiedPasswordHash: credential.passwordHash,
        newPasswordHash,
        mustChangePassword: false,
      });
      if (!isReplaced)
        throw new DomainError(
          409,
          'パスワードが別の操作で変更されました。もう一度loginしてください',
          'password_changed_concurrently',
        );
      await revokeOtherSessions(connection, {
        userId,
        keepTokenHash: principal.session!.tokenHash,
      });
      await writeAuditEvent(connection, { ...changeAudit, outcome: 'success' });
    });
  }

  private dummyHash(): Promise<string> {
    this.dummyPasswordHash ??= this.passwordHasher.hash(randomSecret());
    return this.dummyPasswordHash;
  }
}
