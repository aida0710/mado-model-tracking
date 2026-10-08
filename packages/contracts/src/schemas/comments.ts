import { z } from 'zod';
import type { Comment, CommentAuthor, CommentPage, RunNote } from '../comments.js';
import { cursorPageOf, idSchema, timestampSchema } from './primitives.js';
import { namedContractSchema } from './schemaRegistry.js';
import type { Expect, MutuallyAssignable } from './typeAssertions.js';

export const commentAuthorSchema = namedContractSchema(
  'CommentAuthor',
  z.strictObject({ id: idSchema, displayName: z.string() }),
);
export const commentSchema = namedContractSchema(
  'Comment',
  z.strictObject({
    id: idSchema,
    projectId: idSchema,
    targetType: z.enum(['run', 'model_version', 'report']),
    targetId: idSchema,
    parentCommentId: idSchema.nullable(),
    body: z.string().nullable(),
    author: commentAuthorSchema,
    createdAt: timestampSchema,
    editedAt: timestampSchema.nullable(),
    deleted: z.boolean(),
  }),
);
export const commentPageSchema = namedContractSchema('CommentPage', cursorPageOf(commentSchema));
export const runNoteSchema = namedContractSchema(
  'RunNote',
  z.strictObject({ runId: idSchema, content: z.string() }),
);

type _CommentAuthor = Expect<
  MutuallyAssignable<z.infer<typeof commentAuthorSchema>, CommentAuthor>
>;
type _Comment = Expect<MutuallyAssignable<z.infer<typeof commentSchema>, Comment>>;
type _CommentPage = Expect<MutuallyAssignable<z.infer<typeof commentPageSchema>, CommentPage>>;
type _RunNote = Expect<MutuallyAssignable<z.infer<typeof runNoteSchema>, RunNote>>;
