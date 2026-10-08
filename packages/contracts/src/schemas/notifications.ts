import { z } from 'zod';
import {
  NOTIFICATION_EVENT_TYPES,
  type NotificationChannel,
  type NotificationDelivery,
  type NotificationEvent,
  type NotificationRule,
  type NotificationRuleFilter,
  type NotificationRunSummary,
  type NotificationTestResult,
} from '../notifications.js';
import { idSchema, runKindSchema, runStatusSchema, timestampSchema } from './primitives.js';
import { namedContractSchema } from './schemaRegistry.js';
import type { Expect, MutuallyAssignable } from './typeAssertions.js';

const notificationChannelKindSchema = z.enum(['slack_webhook', 'webhook', 'email']);
const notificationEventTypeSchema = z.enum(NOTIFICATION_EVENT_TYPES);

export const notificationChannelSchema = namedContractSchema(
  'NotificationChannel',
  z.strictObject({
    id: idSchema,
    projectId: idSchema.nullable(),
    kind: notificationChannelKindSchema,
    name: z.string(),
    urlEnv: z.string().nullable(),
    secretEnv: z.string().nullable(),
    recipients: z.array(z.string()),
    enabled: z.boolean(),
    configured: z.boolean(),
    createdBy: idSchema,
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  }),
);
export const notificationRuleFilterSchema = namedContractSchema(
  'NotificationRuleFilter',
  z.strictObject({
    runKinds: z.array(runKindSchema).optional(),
    experimentIds: z.array(idSchema).optional(),
    automationOnly: z.boolean().optional(),
  }),
);
export const notificationRuleSchema = namedContractSchema(
  'NotificationRule',
  z.strictObject({
    id: idSchema,
    projectId: idSchema,
    channelId: idSchema,
    eventTypes: z.array(notificationEventTypeSchema),
    filter: notificationRuleFilterSchema,
    enabled: z.boolean(),
    createdBy: idSchema,
    createdAt: timestampSchema,
  }),
);
export const notificationRunSummarySchema = namedContractSchema(
  'NotificationRunSummary',
  z.strictObject({
    id: idSchema,
    name: z.string(),
    kind: runKindSchema,
    status: runStatusSchema,
    experimentId: idSchema,
    experimentName: z.string(),
    error: z.string().nullable(),
    startedAt: timestampSchema.nullable(),
    endedAt: timestampSchema.nullable(),
  }),
);
// Not a route body: what webhook channels POST to receivers, published so they can validate it.
export const notificationEventSchema = namedContractSchema(
  'NotificationEvent',
  z.strictObject({
    schemaVersion: z.literal(1),
    id: idSchema,
    type: z.enum([...NOTIFICATION_EVENT_TYPES, 'notification.test']),
    occurredAt: timestampSchema,
    title: z.string(),
    project: z.strictObject({ id: idSchema, name: z.string() }).nullable(),
    run: notificationRunSummarySchema.nullable(),
    details: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
    url: z.string().nullable(),
  }),
);
export const notificationDeliverySchema = namedContractSchema(
  'NotificationDelivery',
  z.strictObject({
    id: idSchema,
    ruleId: idSchema,
    channelId: idSchema,
    channelName: z.string(),
    channelKind: notificationChannelKindSchema,
    eventId: idSchema,
    eventType: notificationEventTypeSchema,
    title: z.string(),
    runId: idSchema.nullable(),
    status: z.enum(['pending', 'sending', 'delivered', 'failed']),
    attempts: z.number().int(),
    nextAttemptAt: timestampSchema,
    lastError: z.string().nullable(),
    sentDeliveryId: idSchema.nullable(),
    createdAt: timestampSchema,
    deliveredAt: timestampSchema.nullable(),
  }),
);
export const notificationTestResultSchema = namedContractSchema(
  'NotificationTestResult',
  z.strictObject({
    delivered: z.boolean(),
    sentDeliveryId: idSchema.nullable(),
    error: z.string().nullable(),
  }),
);

type _NotificationChannel = Expect<
  MutuallyAssignable<z.infer<typeof notificationChannelSchema>, NotificationChannel>
>;
type _NotificationRuleFilter = Expect<
  MutuallyAssignable<z.infer<typeof notificationRuleFilterSchema>, NotificationRuleFilter>
>;
type _NotificationRule = Expect<
  MutuallyAssignable<z.infer<typeof notificationRuleSchema>, NotificationRule>
>;
type _NotificationRunSummary = Expect<
  MutuallyAssignable<z.infer<typeof notificationRunSummarySchema>, NotificationRunSummary>
>;
type _NotificationEvent = Expect<
  MutuallyAssignable<z.infer<typeof notificationEventSchema>, NotificationEvent>
>;
type _NotificationDelivery = Expect<
  MutuallyAssignable<z.infer<typeof notificationDeliverySchema>, NotificationDelivery>
>;
type _NotificationTestResult = Expect<
  MutuallyAssignable<z.infer<typeof notificationTestResultSchema>, NotificationTestResult>
>;
