import { useState } from 'react';
import type {
  NotificationChannel,
  NotificationDelivery,
  NotificationRule,
  RunKind,
} from '@mmt/contracts';
import { NOTIFICATION_EVENT_TYPES } from '@mmt/contracts';
import { useAuth } from '../hooks/useAuth';
import { useMutation } from '../hooks/useMutation';
import { useNotificationSettings } from '../hooks/useNotificationSettings';
import { useProject } from '../hooks/useProject';
import { isGlobalAdmin } from '../lib/permissions';
import { formatDate } from '../lib/format';
import {
  buildChannelCreate,
  buildChannelPatch,
  buildRuleCreate,
  describeRuleFilter,
} from '../lib/notificationInput';
import type { FormField, FormValues } from '../types/form';
import { DataTable } from './DataTable';
import { ErrorNotice, Resource } from './Feedback';
import { FormDialog } from './FormDialog';
import { text, textTemplates } from '../i18n/catalog';
import {
  notificationChannelKindLabels,
  notificationDeliveryStatusLabels,
  notificationEventTypeLabels,
} from '../i18n/notifications';

const RUN_KINDS: RunKind[] = ['training', 'finetuning', 'inference', 'evaluation', 'processing'];
const runKindLabel = (kind: RunKind) => text[kind];

type Settings = ReturnType<typeof useNotificationSettings>;

/**
 * Notification channels, rules and recent deliveries of the current Project. Shown to Project
 * admins; channel editing is limited to global administrators as in the API.
 */
export function NotificationSettings() {
  const { project, isProjectAdmin } = useProject();
  const settings = useNotificationSettings(isProjectAdmin ? project.id : null);
  if (!isProjectAdmin) return null;
  return (
    <section className="settings-section">
      <div className="section-heading">
        <h2>{text.notifications}</h2>
      </div>
      <p className="muted">{text.notificationsDescription}</p>
      <ChannelSection settings={settings} projectId={project.id} />
      <RuleSection settings={settings} />
      <DeliverySection settings={settings} />
    </section>
  );
}

function ChannelSection({ settings, projectId }: { settings: Settings; projectId: string }) {
  const { user } = useAuth();
  const canEditChannels = isGlobalAdmin(user);
  const [editing, setEditing] = useState<NotificationChannel | 'new' | null>(null);
  const test = useMutation();
  const [testMessage, setTestMessage] = useState<string | null>(null);
  const runTest = (channel: NotificationChannel) =>
    void test
      .run(() => settings.testChannel(channel.id))
      .then((result) => {
        if (!result) return;
        setTestMessage(
          result.delivered
            ? text.notificationTestDelivered
            : textTemplates.notificationTestError(result.error ?? ''),
        );
      });
  return (
    <>
      <div className="section-heading">
        <h3>{text.notificationChannels}</h3>
        {canEditChannels && (
          <button className="button small" onClick={() => setEditing('new')}>
            {text.newNotificationChannel}
          </button>
        )}
      </div>
      {canEditChannels && (
        <p className="muted">
          {text.notificationChannelHint} {text.notificationEmailHint}
        </p>
      )}
      {testMessage && (
        <div className="notice" role="status">
          {testMessage}
        </div>
      )}
      <ErrorNotice message={test.error} />
      <Resource query={settings.channels}>
        {(channels) => (
          <DataTable
            items={channels}
            rowKey={(channel) => channel.id}
            empty={text.notificationChannelsEmpty}
            columns={[
              { key: 'name', label: text.name, render: (channel) => channel.name },
              {
                key: 'kind',
                label: text.notificationChannelKind,
                render: (channel) => notificationChannelKindLabels[channel.kind],
              },
              {
                key: 'scope',
                label: text.notificationChannelScope,
                render: (channel) =>
                  channel.projectId ? text.notificationScopeProject : text.notificationScopeGlobal,
              },
              {
                key: 'destination',
                label: text.notificationDestination,
                className: 'mono',
                render: (channel) =>
                  channel.kind === 'email' ? channel.recipients.join(', ') : channel.urlEnv,
              },
              {
                key: 'configured',
                label: text.notificationConfigured,
                render: (channel) => configuredLabel(channel),
              },
              {
                key: 'enabled',
                label: text.status,
                render: (channel) => (channel.enabled ? text.enabled : text.disabled),
              },
              ...(canEditChannels
                ? [
                    {
                      key: 'actions',
                      label: text.details,
                      render: (channel: NotificationChannel) => (
                        <div className="access-actions">
                          <button className="button small" onClick={() => setEditing(channel)}>
                            {text.edit}
                          </button>
                          <button
                            className="button small"
                            disabled={test.pending}
                            onClick={() => runTest(channel)}
                          >
                            {text.notificationTest}
                          </button>
                        </div>
                      ),
                    },
                  ]
                : []),
            ]}
          />
        )}
      </Resource>
      {editing && (
        <FormDialog
          title={editing === 'new' ? text.newNotificationChannel : text.editNotificationChannel}
          fields={channelFields(editing === 'new' ? undefined : editing)}
          onSubmit={(values) =>
            editing === 'new'
              ? settings.createChannel(buildChannelCreate(values, projectId))
              : settings.updateChannel(editing.id, buildChannelPatch(values, editing))
          }
          onSaved={() => {
            setEditing(null);
            settings.channels.reload();
          }}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  );
}

// An email channel has no variables of its own; it is unconfigured when the server has no SMTP.
function configuredLabel(channel: NotificationChannel): string {
  if (channel.configured) return text.notificationConfiguredYes;
  return channel.kind === 'email'
    ? text.notificationSmtpUnconfigured
    : text.notificationConfiguredNo;
}

function channelFields(channel?: NotificationChannel): FormField[] {
  const kindOf = (values: FormValues) =>
    channel?.kind ?? (values.kind as string);
  return [
    ...(channel
      ? []
      : [
          {
            name: 'kind',
            label: text.notificationChannelKind,
            type: 'select' as const,
            defaultValue: 'slack_webhook',
            options: Object.entries(notificationChannelKindLabels).map(([value, label]) => ({
              value,
              label,
            })),
          },
          {
            name: 'scope',
            label: text.notificationChannelScope,
            type: 'select' as const,
            defaultValue: 'project',
            options: [
              { value: 'project', label: text.notificationScopeProject },
              { value: 'global', label: text.notificationScopeGlobal },
            ],
          },
        ]),
    { name: 'name', label: text.name, required: true, maxLength: 100, defaultValue: channel?.name },
    {
      name: 'urlEnv',
      label: text.notificationUrlEnv,
      required: true,
      placeholder: 'MMT_NOTIFICATION_ALERTS_URL',
      defaultValue: channel?.urlEnv ?? '',
      visible: (values) => kindOf(values) !== 'email',
    },
    {
      name: 'secretEnv',
      label: text.notificationSecretEnv,
      required: true,
      placeholder: 'MMT_NOTIFICATION_WEBHOOK_SECRET',
      defaultValue: channel?.secretEnv ?? '',
      visible: (values) => kindOf(values) === 'webhook',
    },
    {
      name: 'recipients',
      label: text.notificationRecipients,
      type: 'textarea',
      required: true,
      placeholder: 'ml-team@example.com',
      defaultValue: channel?.recipients.join('\n') ?? '',
      visible: (values) => kindOf(values) === 'email',
    },
    {
      name: 'enabled',
      label: text.enabled,
      type: 'checkbox',
      defaultValue: String(channel?.enabled ?? true),
    },
  ];
}

function RuleSection({ settings }: { settings: Settings }) {
  const [isCreating, setIsCreating] = useState(false);
  const toggle = useMutation();
  const channelName = (channelId: string) =>
    settings.channels.value?.find((channel) => channel.id === channelId)?.name ?? channelId;
  const setEnabled = (rule: NotificationRule) =>
    void toggle
      .run(() => settings.setRuleEnabled(rule.id, !rule.enabled))
      .then((updated) => updated && settings.rules.reload());
  return (
    <>
      <div className="section-heading">
        <h3>{text.notificationRules}</h3>
        <button className="button small" onClick={() => setIsCreating(true)}>
          {text.newNotificationRule}
        </button>
      </div>
      <p className="muted">{text.notificationRuleFixedSettings}</p>
      <ErrorNotice message={toggle.error} />
      <Resource query={settings.rules}>
        {(rules) => (
          <DataTable
            items={rules}
            rowKey={(rule) => rule.id}
            empty={text.notificationRulesEmpty}
            columns={[
              {
                key: 'channel',
                label: text.notificationRuleChannel,
                render: (rule) => channelName(rule.channelId),
              },
              {
                key: 'events',
                label: text.notificationRuleEvents,
                render: (rule) =>
                  rule.eventTypes.map((type) => notificationEventTypeLabels[type]).join('、'),
              },
              {
                key: 'filter',
                label: text.notificationRuleFilter,
                render: (rule) => describeRuleFilter(rule.filter, runKindLabel),
              },
              {
                key: 'enabled',
                label: text.status,
                render: (rule) => (rule.enabled ? text.enabled : text.disabled),
              },
              {
                key: 'actions',
                label: text.details,
                render: (rule) => (
                  <button
                    className="button small"
                    disabled={toggle.pending}
                    onClick={() => setEnabled(rule)}
                  >
                    {rule.enabled ? text.notificationDisable : text.notificationEnable}
                  </button>
                ),
              },
            ]}
          />
        )}
      </Resource>
      {isCreating && (
        <FormDialog
          title={text.newNotificationRule}
          fields={ruleFields(settings)}
          onSubmit={(values) => settings.createRule(buildRuleCreate(values))}
          onSaved={() => {
            setIsCreating(false);
            settings.rules.reload();
          }}
          onClose={() => setIsCreating(false)}
          submitLabel={text.create}
        />
      )}
    </>
  );
}

function ruleFields(settings: Settings): FormField[] {
  const channels = settings.channels.value ?? [];
  return [
    {
      name: 'channelId',
      label: text.notificationRuleChannel,
      type: 'select',
      required: true,
      defaultValue: channels[0]?.id ?? '',
      options: channels.map((channel) => ({
        value: channel.id,
        label: `${channel.name}（${notificationChannelKindLabels[channel.kind]}）`,
      })),
    },
    {
      name: 'eventTypes',
      label: text.notificationRuleEvents,
      type: 'multiselect',
      required: true,
      defaultValue: ['run.failed'],
      options: NOTIFICATION_EVENT_TYPES.map((type) => ({
        value: type,
        label: notificationEventTypeLabels[type],
      })),
    },
    {
      name: 'runKinds',
      label: text.notificationRuleRunKinds,
      type: 'multiselect',
      options: RUN_KINDS.map((kind) => ({ value: kind, label: runKindLabel(kind) })),
    },
    {
      name: 'experimentIds',
      label: text.notificationRuleExperiments,
      type: 'multiselect',
      options: (settings.experiments.value ?? []).map((experiment) => ({
        value: experiment.id,
        label: experiment.name,
      })),
    },
    { name: 'automationOnly', label: text.notificationRuleAutomationOnly, type: 'checkbox' },
  ];
}

function DeliverySection({ settings }: { settings: Settings }) {
  return (
    <>
      <div className="section-heading">
        <h3>{text.notificationDeliveries}</h3>
        <button className="button small" onClick={settings.deliveries.reload}>
          {text.refresh}
        </button>
      </div>
      <Resource query={settings.deliveries}>
        {(deliveries) => (
          <DataTable<NotificationDelivery>
            items={deliveries}
            rowKey={(delivery) => delivery.id}
            empty={text.notificationDeliveriesEmpty}
            columns={[
              {
                key: 'createdAt',
                label: text.notificationDeliveryCreatedAt,
                render: (delivery) => formatDate(delivery.createdAt),
              },
              {
                key: 'event',
                label: text.notificationDeliveryEvent,
                render: (delivery) => delivery.title,
              },
              {
                key: 'channel',
                label: text.notificationRuleChannel,
                render: (delivery) => delivery.channelName,
              },
              {
                key: 'status',
                label: text.status,
                render: (delivery) => notificationDeliveryStatusLabels[delivery.status],
              },
              {
                key: 'attempts',
                label: text.notificationDeliveryAttempts,
                render: (delivery) => delivery.attempts,
              },
              {
                key: 'error',
                label: text.notificationDeliveryError,
                className: 'mono',
                render: (delivery) => delivery.lastError ?? '',
              },
            ]}
          />
        )}
      </Resource>
    </>
  );
}
