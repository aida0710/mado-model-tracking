import type {
  NotificationChannel,
  NotificationChannelCreate,
  NotificationChannelPatch,
  NotificationDelivery,
  NotificationRule,
  NotificationRuleCreate,
  NotificationTestResult,
} from '@mmt/contracts';
import { encodeId, jsonRequest, projectPath, request, requestItems } from './http';

const channelPath = (channelId?: string) =>
  `/notification-channels${channelId === undefined ? '' : `/${encodeId(channelId)}`}`;
const rulePath = (projectId: string, ruleId?: string) =>
  `${projectPath(projectId)}/notification-rules${ruleId === undefined ? '' : `/${encodeId(ruleId)}`}`;

// Recent history only; the API caps a page at 200.
const DELIVERY_HISTORY_LIMIT = 50;

/** Channels (global administrators edit), Project rules and the delivery history. */
export const notificationsApi = {
  /** Channels a Project's rules may use: global ones and the Project's own. */
  projectChannels: (projectId: string, signal?: AbortSignal) =>
    requestItems<NotificationChannel>(`${projectPath(projectId)}/notification-channels`, signal),
  createChannel: (body: NotificationChannelCreate) =>
    request<NotificationChannel>(channelPath(), jsonRequest('POST', body)),
  updateChannel: (channelId: string, body: NotificationChannelPatch) =>
    request<NotificationChannel>(channelPath(channelId), jsonRequest('PATCH', body)),
  testChannel: (channelId: string) =>
    request<NotificationTestResult>(`${channelPath(channelId)}/test`, { method: 'POST' }),
  rules: (projectId: string, signal?: AbortSignal) =>
    requestItems<NotificationRule>(rulePath(projectId), signal),
  createRule: (projectId: string, body: NotificationRuleCreate) =>
    request<NotificationRule>(rulePath(projectId), jsonRequest('POST', body)),
  setRuleEnabled: (projectId: string, ruleId: string, enabled: boolean) =>
    request<NotificationRule>(rulePath(projectId, ruleId), jsonRequest('PATCH', { enabled })),
  deliveries: (projectId: string, signal?: AbortSignal) =>
    requestItems<NotificationDelivery>(
      `${projectPath(projectId)}/notification-deliveries?limit=${DELIVERY_HISTORY_LIMIT}`,
      signal,
    ),
};
