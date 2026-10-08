import { z } from 'zod';
import type { Account, AdminUser, AdminUserPasswordReset } from '../adminUsers.js';
import { userSchema } from './identity.js';
import { timestampSchema } from './primitives.js';
import { namedContractSchema } from './schemaRegistry.js';
import type { Expect, MutuallyAssignable } from './typeAssertions.js';

export const adminUserSchema = namedContractSchema(
  'AdminUser',
  z.strictObject({
    ...userSchema.shape,
    lastLoginAt: timestampSchema.nullable(),
    createdAt: timestampSchema,
  }),
);
export const adminUserPasswordResetSchema = namedContractSchema(
  'AdminUserPasswordReset',
  z.strictObject({ temporaryPassword: z.string() }),
);
export const accountSchema = namedContractSchema(
  'Account',
  z.strictObject({
    user: adminUserSchema,
    groups: z.array(z.string()),
    groupsSyncedAt: timestampSchema.nullable(),
    sessionAuthMethod: z.enum(['local', 'oidc', 'development']).nullable(),
  }),
);

type _AdminUser = Expect<MutuallyAssignable<z.infer<typeof adminUserSchema>, AdminUser>>;
type _AdminUserPasswordReset = Expect<
  MutuallyAssignable<z.infer<typeof adminUserPasswordResetSchema>, AdminUserPasswordReset>
>;
type _Account = Expect<MutuallyAssignable<z.infer<typeof accountSchema>, Account>>;
