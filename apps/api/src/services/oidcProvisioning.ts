import type { User } from '@mmt/contracts';
import type { PoolClient } from 'pg';
import { removesLastGlobalAdmin } from '../domain/globalAdminInvariant.js';
import {
  resolveOidcAccess,
  type GlobalRole,
  type OidcRolePolicy,
} from '../domain/oidcRolePolicy.js';
import type { RequestMetadata } from '../http/requestMetadata.js';
import { writeAuditEvent } from '../repositories/auditRepository.js';
import {
  findAutoLinkCandidates,
  findOidcIdentityUserId,
  findUser,
  insertOidcUser,
  listUserGroups,
  lockAccount,
  lockActiveGlobalAdminIds,
  recordLogin,
  recordOidcIdentityLogin,
  replaceUserGroups,
  updateOidcUserProfile,
} from '../repositories/identityRepository.js';

// Binds an SSO login to a user: finds the linked identity, optionally links a local account by
// verified email, creates the user just in time, and syncs the global role and groups from the IdP.

export interface OidcClaims {
  issuer: string;
  subject: string;
  email: string;
  emailVerified: boolean;
  displayName: string;
  // Raw claim values; non-string entries are dropped by the policy.
  groups: readonly unknown[];
}

// Why an SSO login was refused. Users get the same 401 for all of them; operators read the reason
// in the log and in the auth.oidc.denied audit event.
export type OidcLoginDenialReason =
  | 'email_not_verified'
  | 'group_not_allowed'
  | 'privileged_link_required'
  | 'user_disabled'
  | 'last_admin'
  | 'service_account';

export class OidcLoginDeniedError extends Error {
  constructor(
    readonly reason: OidcLoginDenialReason,
    readonly userId: string | null = null,
  ) {
    super(`OIDC login denied: ${reason}`);
    this.name = 'OidcLoginDeniedError';
  }
}

export interface OidcProvisioningPolicy {
  rolePolicy: OidcRolePolicy;
  autoLinkVerifiedEmail: boolean;
}

export interface OidcSyncInput {
  userId: string;
  claims: OidcClaims;
  rolePolicy: OidcRolePolicy;
  metadata?: RequestMetadata;
}

interface AccountOrigin {
  created: boolean;
  linkedExisting: boolean;
}

function globalRoleOf(isAdmin: boolean): GlobalRole {
  return isAdmin ? 'admin' : 'user';
}

function difference(left: string[], right: string[]): string[] {
  return left.filter((value) => !right.includes(value));
}

async function syncAccount(
  connection: PoolClient,
  input: OidcSyncInput,
  origin: AccountOrigin,
): Promise<User> {
  const { userId, claims } = input;
  const account = await lockAccount(connection, userId);
  if (!account) throw new Error('OIDC user is missing');
  // A Service Account never logs in, even if an SSO identity was linked to it by hand.
  if (account.kind !== 'human') throw new OidcLoginDeniedError('service_account', userId);
  // Disabling is local to this app, so it overrides a still-valid SSO account.
  if (account.status !== 'active') throw new OidcLoginDeniedError('user_disabled', userId);
  const access = resolveOidcAccess(input.rolePolicy, claims.groups);
  if (!access.allowed) throw new OidcLoginDeniedError('group_not_allowed', userId);
  if (account.isAdmin && !access.isAdmin) {
    const activeAdminIds = await lockActiveGlobalAdminIds(connection);
    if (removesLastGlobalAdmin(activeAdminIds, { userId, isAdmin: false }))
      throw new OidcLoginDeniedError('last_admin', userId);
  }
  await updateOidcUserProfile(connection, {
    userId,
    email: claims.email,
    displayName: claims.displayName,
    isAdmin: access.isAdmin,
  });
  const groupsBefore = await listUserGroups(connection, userId);
  await replaceUserGroups(connection, userId, access.groups);
  const groupsAdded = difference(access.groups, groupsBefore);
  const groupsRemoved = difference(groupsBefore, access.groups);
  const globalRoleBefore = globalRoleOf(account.isAdmin);
  const changed =
    origin.created ||
    origin.linkedExisting ||
    globalRoleBefore !== access.globalRole ||
    groupsAdded.length > 0 ||
    groupsRemoved.length > 0;
  // Role changes include promotions, so they are recorded in the same transaction as the sync.
  if (changed)
    await writeAuditEvent(connection, {
      actorType: 'user',
      actorUserId: userId,
      action: 'auth.oidc.sync',
      outcome: 'success',
      resourceType: 'user',
      resourceId: userId,
      details: {
        ...origin,
        globalRoleBefore,
        globalRoleAfter: access.globalRole,
        groupsAdded,
        groupsRemoved,
      },
      ...input.metadata,
    });
  return (await findUser(connection, userId))!;
}

// Applies the IdP's current groups to an already linked user. Session recheck calls this with
// UserInfo claims; a denial means the user must lose access.
export async function syncOidcIdentity(
  connection: PoolClient,
  input: OidcSyncInput,
): Promise<User> {
  return syncAccount(connection, input, { created: false, linkedExisting: false });
}

async function findLinkableLocalUserId(
  connection: PoolClient,
  email: string,
): Promise<string | undefined> {
  const candidates = await findAutoLinkCandidates(connection, email);
  // Several local accounts with one email cannot be told apart, so none of them is linked.
  if (candidates.length !== 1) return undefined;
  const candidate = candidates[0]!;
  if (candidate.isPrivileged)
    throw new OidcLoginDeniedError('privileged_link_required', candidate.id);
  return candidate.id;
}

// Runs inside the caller's transaction so a denial leaves no user, identity or group rows behind.
export async function provisionOidcLogin(
  connection: PoolClient,
  login: { claims: OidcClaims; policy: OidcProvisioningPolicy; metadata?: RequestMetadata },
): Promise<User> {
  const { claims, policy } = login;
  if (!claims.emailVerified) throw new OidcLoginDeniedError('email_not_verified');
  let userId = await findOidcIdentityUserId(connection, claims);
  const access = resolveOidcAccess(policy.rolePolicy, claims.groups);
  // Checked before creating anyone, so a user outside the allowed groups never gets a row.
  if (!access.allowed) throw new OidcLoginDeniedError('group_not_allowed', userId ?? null);
  const origin: AccountOrigin = { created: false, linkedExisting: false };
  if (!userId && policy.autoLinkVerifiedEmail) {
    userId = await findLinkableLocalUserId(connection, claims.email);
    origin.linkedExisting = userId !== undefined;
  }
  if (!userId) {
    userId = await insertOidcUser(connection, claims);
    origin.created = true;
  }
  await recordOidcIdentityLogin(connection, {
    issuer: claims.issuer,
    subject: claims.subject,
    userId,
    email: claims.email,
    emailVerified: claims.emailVerified,
    groups: access.groups,
  });
  await recordLogin(connection, userId);
  return syncAccount(
    connection,
    { userId, claims, rolePolicy: policy.rolePolicy, metadata: login.metadata },
    origin,
  );
}
