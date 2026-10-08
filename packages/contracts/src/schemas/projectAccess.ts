import { z } from 'zod';
import type {
  ProjectGroupBinding,
  ProjectMember,
  ProjectMemberGroupRole,
  UserSearchResult,
} from '../projectAccess.js';
import { userSchema } from './identity.js';
import { idSchema, projectRoleSchema, timestampSchema } from './primitives.js';
import { namedContractSchema } from './schemaRegistry.js';
import type { Expect, MutuallyAssignable } from './typeAssertions.js';

export const projectGroupBindingSchema = namedContractSchema(
  'ProjectGroupBinding',
  z.strictObject({
    projectId: idSchema,
    group: z.string(),
    role: projectRoleSchema,
    createdBy: idSchema.nullable(),
    createdAt: timestampSchema,
  }),
);
export const projectMemberGroupRoleSchema = namedContractSchema(
  'ProjectMemberGroupRole',
  z.strictObject({ group: z.string(), role: projectRoleSchema }),
);
export const projectMemberSchema = namedContractSchema(
  'ProjectMember',
  z.strictObject({
    user: userSchema,
    role: projectRoleSchema,
    directRole: projectRoleSchema.nullable(),
    groups: z.array(projectMemberGroupRoleSchema),
  }),
);
export const userSearchResultSchema = namedContractSchema(
  'UserSearchResult',
  z.strictObject({ id: idSchema, email: z.string(), displayName: z.string() }),
);

type _ProjectGroupBinding = Expect<
  MutuallyAssignable<z.infer<typeof projectGroupBindingSchema>, ProjectGroupBinding>
>;
type _ProjectMemberGroupRole = Expect<
  MutuallyAssignable<z.infer<typeof projectMemberGroupRoleSchema>, ProjectMemberGroupRole>
>;
type _ProjectMember = Expect<
  MutuallyAssignable<z.infer<typeof projectMemberSchema>, ProjectMember>
>;
type _UserSearchResult = Expect<
  MutuallyAssignable<z.infer<typeof userSearchResultSchema>, UserSearchResult>
>;
