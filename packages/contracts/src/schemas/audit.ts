import { z } from 'zod';
import type { AuditEvent, AuditEventPage } from '../audit.js';
import { cursorPageOf, idSchema, jsonObjectSchema, timestampSchema } from './primitives.js';
import { namedContractSchema } from './schemaRegistry.js';
import type { Expect, MutuallyAssignable } from './typeAssertions.js';

export const auditEventSchema = namedContractSchema(
  'AuditEvent',
  z.strictObject({
    id: idSchema,
    occurredAt: timestampSchema,
    actorType: z.enum(['user', 'token', 'system']),
    actorUserId: idSchema.nullable(),
    actorName: z.string().nullable(),
    actorTokenId: idSchema.nullable(),
    action: z.string(),
    outcome: z.enum(['success', 'denied', 'failed']),
    resourceType: z.string(),
    resourceId: z.string().nullable(),
    projectId: idSchema.nullable(),
    projectName: z.string().nullable(),
    details: jsonObjectSchema,
    ip: z.string().nullable(),
    userAgent: z.string().nullable(),
  }),
);
export const auditEventPageSchema = namedContractSchema(
  'AuditEventPage',
  cursorPageOf(auditEventSchema),
);

type _AuditEvent = Expect<MutuallyAssignable<z.infer<typeof auditEventSchema>, AuditEvent>>;
type _AuditEventPage = Expect<
  MutuallyAssignable<z.infer<typeof auditEventPageSchema>, AuditEventPage>
>;
