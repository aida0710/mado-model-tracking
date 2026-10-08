import type { ServiceAccount } from '@mmt/contracts';
import type { z } from 'zod';
import type { Principal } from '../auth/principal.js';
import { transaction, type Connection, type Database } from '../db/database.js';
import { DomainError, notFound } from '../domain/errors.js';
import type {
  serviceAccountCreateSchema,
  serviceAccountTokenCreateSchema,
  serviceAccountUpdateSchema,
} from '../domain/serviceAccountValidation.js';
import { scopesBeyondRole } from '../domain/tokenScopes.js';
import type { RequestMetadata } from '../http/requestMetadata.js';
import { writeAuditEvent } from '../repositories/auditRepository.js';
import {
  findServiceAccount,
  insertServiceAccount,
  listServiceAccounts,
  lockServiceAccount,
  setServiceAccountRole,
  setServiceAccountStatus,
  updateServiceAccountDescription,
} from '../repositories/serviceAccountRepository.js';
import { requireProject } from './accessService.js';
import {
  auditActor,
  NO_REQUEST_METADATA,
  recordDenial,
  type AuditEventDraft,
} from './auditService.js';
import {
  issueApiToken,
  requireSession,
  requireTokenExpiry,
  tokenCreateAuditDetails,
  type IssuedToken,
} from './tokenService.js';

interface ServiceAccountReference {
  projectId: string;
  serviceAccountId: string;
}

/**
 * Service Accounts of a Project and the tokens issued to them. Only Project admins in a browser
 * session manage them, so a leaked token cannot create accounts or mint more tokens.
 */
export class ServiceAccountService {
  private readonly database: Database;
  private readonly tokenMaxLifetimeDays: number;

  constructor(dependencies: { database: Database; tokenMaxLifetimeDays: number }) {
    this.database = dependencies.database;
    this.tokenMaxLifetimeDays = dependencies.tokenMaxLifetimeDays;
  }

  async list(principal: Principal, projectId: string): Promise<ServiceAccount[]> {
    requireSession(principal, 'Service Accountの管理');
    await requireProjectAdmin(this.database, principal, projectId);
    return listServiceAccounts(this.database, projectId);
  }

  async create(
    principal: Principal,
    projectId: string,
    input: z.infer<typeof serviceAccountCreateSchema>,
    request: RequestMetadata = NO_REQUEST_METADATA,
  ): Promise<ServiceAccount> {
    const draft: AuditEventDraft = {
      ...auditActor(principal),
      ...request,
      action: 'service_account.create',
      resourceType: 'service_account',
      projectId,
      details: { name: input.name, role: input.role },
    };
    return recordDenial(this.database, draft, async () => {
      requireSession(principal, 'Service Accountの作成');
      return transaction(this.database, async (connection) => {
        await requireProjectAdmin(connection, principal, projectId);
        const account = await insertServiceAccount(connection, {
          projectId,
          name: input.name,
          description: input.description,
          role: input.role,
          createdBy: principal.user.id,
        });
        await writeAuditEvent(connection, { ...draft, outcome: 'success', resourceId: account.id });
        return account;
      });
    });
  }

  async update(
    principal: Principal,
    reference: ServiceAccountReference,
    input: z.infer<typeof serviceAccountUpdateSchema>,
    request: RequestMetadata = NO_REQUEST_METADATA,
  ): Promise<ServiceAccount> {
    const draft: AuditEventDraft = {
      ...auditActor(principal),
      ...request,
      action: 'service_account.update',
      resourceType: 'service_account',
      resourceId: reference.serviceAccountId,
      projectId: reference.projectId,
      details: { role: input.role ?? null, status: input.status ?? null },
    };
    return recordDenial(this.database, draft, async () => {
      requireSession(principal, 'Service Accountの変更');
      return transaction(this.database, async (connection) => {
        await requireProjectAdmin(connection, principal, reference.projectId);
        const before = await lockServiceAccount(connection, reference);
        if (!before) notFound('Service Account');
        const { serviceAccountId, projectId } = reference;
        if (input.description !== undefined)
          await updateServiceAccountDescription(connection, {
            serviceAccountId,
            description: input.description,
          });
        if (input.role !== undefined)
          await setServiceAccountRole(connection, {
            projectId,
            serviceAccountId,
            role: input.role,
          });
        if (input.status !== undefined && input.status !== before.status)
          await setServiceAccountStatus(connection, { serviceAccountId, status: input.status });
        const after = (await findServiceAccount(connection, reference))!;
        await writeAuditEvent(connection, {
          ...draft,
          outcome: 'success',
          details: {
            previousRole: before.role,
            role: after.role,
            previousStatus: before.status,
            status: after.status,
            descriptionChanged: input.description !== undefined,
          },
        });
        return after;
      });
    });
  }

  async createToken(
    principal: Principal,
    reference: ServiceAccountReference,
    input: z.infer<typeof serviceAccountTokenCreateSchema>,
    request: RequestMetadata = NO_REQUEST_METADATA,
  ): Promise<IssuedToken> {
    const draft: AuditEventDraft = {
      ...auditActor(principal),
      ...request,
      action: 'token.create',
      resourceType: 'api_token',
      projectId: reference.projectId,
      details: {
        name: input.name,
        kind: 'service',
        scopes: input.scopes,
        expiresAt: input.expiresAt ?? null,
        ownerType: 'service_account',
        ownerUserId: reference.serviceAccountId,
      },
    };
    return recordDenial(this.database, draft, async () => {
      requireSession(principal, 'Tokenの発行');
      return transaction(this.database, async (connection) => {
        await requireProjectAdmin(connection, principal, reference.projectId);
        const account = await lockServiceAccount(connection, reference);
        if (!account) notFound('Service Account');
        if (account.status !== 'active')
          throw new DomainError(
            409,
            '無効化したService Accountにはtokenを発行できません',
            'service_account_disabled',
          );
        if (!account.role)
          throw new DomainError(
            409,
            'Service AccountにProjectのRoleがありません',
            'service_account_role_missing',
          );
        const excessScopes = scopesBeyondRole(input.scopes, account.role);
        if (excessScopes.length)
          throw new DomainError(
            422,
            `Service AccountのRole（${account.role}）では使えないscopeです: ${excessScopes.join(', ')}`,
            'scope_exceeds_role',
          );
        const issued = await issueApiToken(connection, {
          ownerUserId: account.id,
          createdByUserId: principal.user.id,
          projectId: reference.projectId,
          name: input.name,
          kind: 'service',
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
      });
    });
  }
}

function requireProjectAdmin(
  connection: Connection,
  principal: Principal,
  projectId: string,
): Promise<unknown> {
  return requireProject(connection, principal, { projectId, role: 'admin', scope: 'admin' });
}
