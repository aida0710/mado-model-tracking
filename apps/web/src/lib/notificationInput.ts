import type {
  NotificationChannel,
  NotificationChannelCreate,
  NotificationChannelKind,
  NotificationChannelPatch,
  NotificationEventType,
  NotificationRuleCreate,
  NotificationRuleFilter,
  RunKind,
} from '@mmt/contracts';
import { text } from '../i18n/catalog';
import { notificationsTextTemplates } from '../i18n/notifications';
import {
  getFieldValue,
  getOptionalValue,
  getSelectedValues,
  splitLines,
  type FormValues,
} from './formValues';

/** The channel scope field: every Project, or only the Project being edited. */
export type NotificationChannelScope = 'global' | 'project';

// Mirrors the API rule: Slack needs a URL, a webhook a URL and a signing secret, email recipients.
function destinationSettings(kind: NotificationChannelKind, values: FormValues) {
  return {
    urlEnv: kind === 'email' ? null : (getOptionalValue(values, 'urlEnv') ?? null),
    secretEnv: kind === 'webhook' ? (getOptionalValue(values, 'secretEnv') ?? null) : null,
    recipients: kind === 'email' ? splitLines(getFieldValue(values, 'recipients')) : [],
  };
}

export function buildChannelCreate(
  values: FormValues,
  projectId: string,
): NotificationChannelCreate {
  const kind = getFieldValue(values, 'kind') as NotificationChannelKind;
  const scope = getFieldValue(values, 'scope') as NotificationChannelScope;
  return {
    kind,
    name: getFieldValue(values, 'name').trim(),
    projectId: scope === 'project' ? projectId : null,
    enabled: getFieldValue(values, 'enabled') !== 'false',
    ...destinationSettings(kind, values),
  };
}

export function buildChannelPatch(
  values: FormValues,
  channel: Pick<NotificationChannel, 'kind'>,
): NotificationChannelPatch {
  return {
    name: getFieldValue(values, 'name').trim(),
    enabled: getFieldValue(values, 'enabled') !== 'false',
    ...destinationSettings(channel.kind, values),
  };
}

export function buildRuleCreate(values: FormValues): NotificationRuleCreate {
  const channelId = getFieldValue(values, 'channelId');
  if (!channelId) throw new Error(text.notificationRuleChannelRequired);
  const eventTypes = getSelectedValues(values, 'eventTypes') as NotificationEventType[];
  if (!eventTypes.length) throw new Error(text.notificationRuleEventsRequired);
  const runKinds = getSelectedValues(values, 'runKinds') as RunKind[];
  const experimentIds = getSelectedValues(values, 'experimentIds');
  const filter: NotificationRuleFilter = {
    ...(runKinds.length ? { runKinds } : {}),
    ...(experimentIds.length ? { experimentIds } : {}),
    ...(getFieldValue(values, 'automationOnly') === 'true' ? { automationOnly: true } : {}),
  };
  return { channelId, eventTypes, filter };
}

/** One-line summary of a rule filter for the rule table. */
export function describeRuleFilter(
  filter: NotificationRuleFilter,
  runKindLabel: (kind: RunKind) => string,
): string {
  const parts = [
    filter.runKinds?.length
      ? notificationsTextTemplates.notificationRuleFilterRunKinds(
          filter.runKinds.map(runKindLabel).join('、'),
        )
      : null,
    filter.experimentIds?.length
      ? notificationsTextTemplates.notificationRuleFilterExperiments(filter.experimentIds.length)
      : null,
    filter.automationOnly ? text.notificationRuleAutomationOnly : null,
  ].filter((part): part is string => part !== null);
  return parts.length ? parts.join(' / ') : text.notificationRuleFilterNone;
}
