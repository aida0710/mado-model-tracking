import { z } from 'zod';
import type { ServiceAccount } from '../serviceAccounts.js';
import { idSchema, projectRoleSchema, timestampSchema } from './primitives.js';
import { namedContractSchema } from './schemaRegistry.js';
import type { Expect, MutuallyAssignable } from './typeAssertions.js';

export const serviceAccountSchema = namedContractSchema(
  'ServiceAccount',
  z.strictObject({
    id: idSchema,
    projectId: idSchema,
    name: z.string(),
    description: z.string(),
    role: projectRoleSchema.nullable(),
    status: z.enum(['active', 'disabled']),
    createdAt: timestampSchema,
  }),
);

type _ServiceAccount = Expect<
  MutuallyAssignable<z.infer<typeof serviceAccountSchema>, ServiceAccount>
>;
