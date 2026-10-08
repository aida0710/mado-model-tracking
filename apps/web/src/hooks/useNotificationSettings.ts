import type {
  NotificationChannelCreate,
  NotificationChannelPatch,
  NotificationRuleCreate,
} from '@mmt/contracts';
import { notificationsApi } from '../api/notifications';
import { trackingApi } from '../api/tracking';
import { useQuery } from './useQuery';

/**
 * Channels, rules, recent deliveries and experiments (for rule filters) of a Project's
 * notification settings. Pass null when the user is not a Project admin: the API refuses them.
 */
export function useNotificationSettings(projectId: string | null) {
  const channels = useQuery(projectId && `${projectId}:notification-channels`, (signal) =>
    notificationsApi.projectChannels(projectId!, signal),
  );
  const rules = useQuery(projectId && `${projectId}:notification-rules`, (signal) =>
    notificationsApi.rules(projectId!, signal),
  );
  const deliveries = useQuery(projectId && `${projectId}:notification-deliveries`, (signal) =>
    notificationsApi.deliveries(projectId!, signal),
  );
  const experiments = useQuery(projectId && `${projectId}:notification-experiments`, (signal) =>
    trackingApi.experiments(projectId!, signal),
  );
  return {
    channels,
    rules,
    deliveries,
    experiments,
    createChannel: (body: NotificationChannelCreate) => notificationsApi.createChannel(body),
    updateChannel: (channelId: string, body: NotificationChannelPatch) =>
      notificationsApi.updateChannel(channelId, body),
    testChannel: (channelId: string) => notificationsApi.testChannel(channelId),
    createRule: (body: NotificationRuleCreate) => notificationsApi.createRule(projectId!, body),
    setRuleEnabled: (ruleId: string, enabled: boolean) =>
      notificationsApi.setRuleEnabled(projectId!, ruleId, enabled),
  };
}
