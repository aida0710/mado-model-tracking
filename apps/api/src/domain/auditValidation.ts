import { z } from 'zod';
import { uuidSchema } from './validation.js';

const DEFAULT_AUDIT_EVENT_LIMIT = 50;
// Bounds one page so a global administrator cannot request the whole unbounded log at once.
const MAX_AUDIT_EVENT_LIMIT = 200;

const projectAuditEventQueryFields = {
  action: z.string().min(1).max(200).optional(),
  actorUserId: uuidSchema.optional(),
  outcome: z.enum(['success', 'denied', 'failed']).optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_AUDIT_EVENT_LIMIT)
    .default(DEFAULT_AUDIT_EVENT_LIMIT),
  cursor: uuidSchema.optional(),
};

export const projectAuditEventQuerySchema = z.strictObject(projectAuditEventQueryFields);
export const auditEventQuerySchema = z.strictObject({
  ...projectAuditEventQueryFields,
  projectId: uuidSchema.optional(),
});

export type ProjectAuditEventQuery = z.infer<typeof projectAuditEventQuerySchema>;
export type AuditEventQuery = z.infer<typeof auditEventQuerySchema>;
