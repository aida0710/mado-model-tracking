import { z } from 'zod';
import { COMMENT_MAX_LENGTH } from '@mmt/contracts';
import { uuidSchema } from './validation.js';

const DEFAULT_COMMENT_PAGE_LIMIT = 100;
// Bounds one page so a long discussion is fetched in steps instead of in one response.
const MAX_COMMENT_PAGE_LIMIT = 200;

export const commentTargetTypeSchema = z.enum(['run', 'model_version', 'report']);

// A body of only whitespace would render as an empty comment.
const commentBodySchema = z
  .string()
  .max(COMMENT_MAX_LENGTH)
  .refine((body) => body.trim().length > 0);

export const commentCreateSchema = z.strictObject({
  targetType: commentTargetTypeSchema,
  targetId: uuidSchema,
  parentCommentId: uuidSchema.nullable().optional(),
  body: commentBodySchema,
});

export const commentUpdateSchema = z.strictObject({ body: commentBodySchema });

export const commentListQuerySchema = z.strictObject({
  targetType: commentTargetTypeSchema,
  targetId: uuidSchema,
  cursor: uuidSchema.optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_COMMENT_PAGE_LIMIT)
    .default(DEFAULT_COMMENT_PAGE_LIMIT),
});

export type CommentCreateInput = z.infer<typeof commentCreateSchema>;
export type CommentListQuery = z.infer<typeof commentListQuerySchema>;
