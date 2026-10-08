import { z } from 'zod';
import type {
  JobStatus,
  JsonObject,
  JsonValue,
  ProjectRole,
  RunKind,
  RunStatus,
} from '../index.js';
import { namedContractSchema } from './schemaRegistry.js';
import type { Expect, MutuallyAssignable } from './typeAssertions.js';

// Any 8-4-4-4-12 hex ID: fixtures and imported rows are not always RFC 4122 variants.
export const idSchema = z.guid();
// Timestamps leave the API as ISO 8601 strings from Date.toISOString().
export const timestampSchema = z.iso.datetime({ offset: true });
export const jsonValueSchema = namedContractSchema('JsonValue', z.json());
export const jsonObjectSchema = namedContractSchema(
  'JsonObject',
  z.record(z.string(), jsonValueSchema),
);
export const stringMapSchema = z.record(z.string(), z.string());
export const projectRoleSchema = z.enum(['viewer', 'editor', 'admin']);
export const runKindSchema = z.enum([
  'inference',
  'evaluation',
  'training',
  'finetuning',
  'processing',
]);
export const runStatusSchema = z.enum(['queued', 'running', 'finished', 'failed', 'canceled']);
export const jobStatusSchema = z.enum([...runStatusSchema.options, 'claimed']);

/** `{items: T[]}`: the shape of every plain list response. */
export function itemsOf<T extends z.ZodType>(item: T) {
  return z.strictObject({ items: z.array(item) });
}

/** A keyset page whose last page has `nextCursor: null`. */
export function cursorPageOf<T extends z.ZodType>(item: T) {
  return z.strictObject({ items: z.array(item), nextCursor: z.string().nullable() });
}

type _JsonValue = Expect<MutuallyAssignable<z.infer<typeof jsonValueSchema>, JsonValue>>;
type _JsonObject = Expect<MutuallyAssignable<z.infer<typeof jsonObjectSchema>, JsonObject>>;
type _ProjectRole = Expect<MutuallyAssignable<z.infer<typeof projectRoleSchema>, ProjectRole>>;
type _RunKind = Expect<MutuallyAssignable<z.infer<typeof runKindSchema>, RunKind>>;
type _RunStatus = Expect<MutuallyAssignable<z.infer<typeof runStatusSchema>, RunStatus>>;
type _JobStatus = Expect<MutuallyAssignable<z.infer<typeof jobStatusSchema>, JobStatus>>;
