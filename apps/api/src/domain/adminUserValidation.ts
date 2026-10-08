import { z } from 'zod';

// Same rule as the users.username CHECK in 010_local_accounts.sql.
const USERNAME_PATTERN = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
// Generous bound: the password hasher enforces the real 12-1024 byte rule.
const MAX_PASSWORD_INPUT_LENGTH = 4096;
const MAX_DISPLAY_NAME_LENGTH = 200;
const MAX_EMAIL_LENGTH = 254;
const MAX_QUERY_LENGTH = 200;
// The admin table shows one page; operators narrow it with the search box instead of paging.
export const ADMIN_USER_LIST_LIMIT = 500;

const displayNameSchema = z.string().trim().min(1).max(MAX_DISPLAY_NAME_LENGTH);
const statusSchema = z.enum(['active', 'disabled']);

export const adminUserQuerySchema = z.strictObject({
  query: z.string().trim().max(MAX_QUERY_LENGTH).optional(),
  status: statusSchema.optional(),
  kind: z.enum(['human', 'service']).optional(),
});

export const adminUserCreateSchema = z.strictObject({
  username: z.string().trim().toLowerCase().regex(USERNAME_PATTERN),
  displayName: displayNameSchema,
  email: z
    .string()
    .trim()
    .max(MAX_EMAIL_LENGTH)
    .regex(/^[^\s@]+@[^\s@]+$/)
    .optional(),
  password: z.string().min(1).max(MAX_PASSWORD_INPUT_LENGTH),
  isAdmin: z.boolean(),
});

export const adminUserPatchSchema = z
  .strictObject({
    status: statusSchema.optional(),
    displayName: displayNameSchema.optional(),
    isAdmin: z.boolean().optional(),
  })
  .refine((patch) => Object.keys(patch).length > 0);

export type AdminUserCreateInput = z.infer<typeof adminUserCreateSchema>;
export type AdminUserPatchInput = z.infer<typeof adminUserPatchSchema>;
