import { randomUUID } from 'node:crypto';
import type {
  JsonObject,
  NotificationChannel,
  NotificationChannelKind,
  NotificationDelivery,
  NotificationRule,
  NotificationTestResult,
} from '@mmt/contracts';
import {
  isNotificationChannelConfigured,
  NotificationSendError,
  resolveNotificationDestination,
  type NotificationSenders,
} from '@mmt/platform';
import type { Principal } from '../auth/principal.js';
import { first, rows, transaction, type Connection, type Database } from '../db/database.js';
import { DomainError, notFound } from '../domain/errors.js';
import type {
  NotificationChannelCreateInput,
  NotificationChannelPatchInput,
  NotificationRuleCreateInput,
} from '../domain/notificationValidation.js';
import type { RequestMetadata } from '../http/requestMetadata.js';
import { writeAuditEvent } from '../repositories/auditRepository.js';
import { requireGlobalAdmin, requireProject } from './accessService.js';
import {
  auditActor,
  NO_REQUEST_METADATA,
  recordDenial,
  type AuditEventDraft,
} from './auditService.js';

type ChannelRow = Omit<NotificationChannel, 'configured'>;

interface ChannelDestinationSettings {
  kind: NotificationChannelKind;
  urlEnv: string | null;
  secretEnv: string | null;
  recipients: string[];
}

const CHANNEL_COLUMNS =
  'id,project_id,kind,name,url_env,secret_env,recipients,enabled,created_by,created_at,updated_at';

// Mirrors the notification_channels CHECK so the API answers 422 with a reason instead of 23514.
function validateDestination(settings: ChannelDestinationSettings): void {
  const hasRecipients = settings.recipients.length > 0;
  const isValid =
    settings.kind === 'email'
      ? hasRecipients && settings.urlEnv === null && settings.secretEnv === null
      : !hasRecipients &&
        settings.urlEnv !== null &&
        (settings.kind === 'webhook' ? settings.secretEnv !== null : settings.secretEnv === null);
  if (!isValid)
    throw new DomainError(
      422,
      '通知先の種類に合う設定を指定してください（Slackは urlEnv、Webhookは urlEnv と secretEnv、メールは recipients）',
      'notification_channel_invalid',
    );
}

/** Channels (global administrators), rules (Project admins), delivery history and test sends. */
export class NotificationService {
  constructor(
    private readonly options: {
      database: Database;
      senders: NotificationSenders;
      environment: NodeJS.ProcessEnv;
    },
  ) {}

  async listChannels(principal: Principal): Promise<NotificationChannel[]> {
    requireGlobalAdmin(principal);
    const channels = await rows<ChannelRow>(
      this.options.database,
      `SELECT ${CHANNEL_COLUMNS} FROM notification_channels ORDER BY project_id NULLS FIRST,name`,
    );
    return channels.map((channel) => this.present(channel));
  }

  /** Channels a Project's rules may use: global ones and the Project's own. */
  async listProjectChannels(
    principal: Principal,
    projectId: string,
  ): Promise<NotificationChannel[]> {
    await this.requireProjectAdmin(principal, projectId);
    const channels = await rows<ChannelRow>(
      this.options.database,
      `SELECT ${CHANNEL_COLUMNS} FROM notification_channels
      WHERE project_id IS NULL OR project_id=$1 ORDER BY project_id NULLS FIRST,name`,
      [projectId],
    );
    return channels.map((channel) => this.present(channel));
  }

  async createChannel(
    principal: Principal,
    input: NotificationChannelCreateInput,
    request: RequestMetadata = NO_REQUEST_METADATA,
  ): Promise<NotificationChannel> {
    const draft = this.auditDraft({
      principal,
      request,
      action: 'notification.channel.create',
      resourceType: 'notification_channel',
      projectId: input.projectId ?? null,
    });
    return recordDenial(this.options.database, draft, async () => {
      // Only the server administrator may choose where server-side secrets and Run data are sent.
      requireGlobalAdmin(principal);
      const settings = {
        kind: input.kind,
        urlEnv: input.urlEnv ?? null,
        secretEnv: input.secretEnv ?? null,
        recipients: input.recipients ?? [],
      };
      validateDestination(settings);
      return transaction(this.options.database, async (connection) => {
        if (input.projectId) await this.requireProjectExists(connection, input.projectId);
        await this.requireUniqueName(connection, {
          projectId: input.projectId ?? null,
          name: input.name,
        });
        const created = (await first<ChannelRow>(
          connection,
          `INSERT INTO notification_channels(project_id,kind,name,url_env,secret_env,recipients,enabled,created_by)
          VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8) RETURNING ${CHANNEL_COLUMNS}`,
          [
            input.projectId ?? null,
            settings.kind,
            input.name,
            settings.urlEnv,
            settings.secretEnv,
            JSON.stringify(settings.recipients),
            input.enabled ?? true,
            principal.user.id,
          ],
        ))!;
        await writeAuditEvent(connection, {
          ...draft,
          resourceId: created.id,
          outcome: 'success',
          details: this.auditDetails(created),
        });
        return this.present(created);
      });
    });
  }

  async updateChannel(
    principal: Principal,
    channelId: string,
    input: NotificationChannelPatchInput,
    request: RequestMetadata = NO_REQUEST_METADATA,
  ): Promise<NotificationChannel> {
    const draft = this.auditDraft({
      principal,
      request,
      action: 'notification.channel.update',
      resourceType: 'notification_channel',
      resourceId: channelId,
    });
    return recordDenial(this.options.database, draft, async () => {
      requireGlobalAdmin(principal);
      return transaction(this.options.database, async (connection) => {
        const current = await first<ChannelRow>(
          connection,
          `SELECT ${CHANNEL_COLUMNS} FROM notification_channels WHERE id=$1 FOR UPDATE`,
          [channelId],
        );
        if (!current) notFound('通知先');
        const settings = {
          kind: current.kind,
          urlEnv: input.urlEnv === undefined ? current.urlEnv : input.urlEnv,
          secretEnv: input.secretEnv === undefined ? current.secretEnv : input.secretEnv,
          recipients: input.recipients ?? current.recipients,
        };
        validateDestination(settings);
        const name = input.name ?? current.name;
        if (name !== current.name)
          await this.requireUniqueName(connection, {
            projectId: current.projectId,
            name,
          });
        const updated = (await first<ChannelRow>(
          connection,
          `UPDATE notification_channels SET name=$2,url_env=$3,secret_env=$4,recipients=$5::jsonb,
            enabled=$6,updated_by=$7,updated_at=now() WHERE id=$1 RETURNING ${CHANNEL_COLUMNS}`,
          [
            channelId,
            name,
            settings.urlEnv,
            settings.secretEnv,
            JSON.stringify(settings.recipients),
            input.enabled ?? current.enabled,
            principal.user.id,
          ],
        ))!;
        await writeAuditEvent(connection, {
          ...draft,
          projectId: updated.projectId,
          outcome: 'success',
          details: {
            ...this.auditDetails(updated),
            changed: Object.keys(input).sort(),
          },
        });
        return this.present(updated);
      });
    });
  }

  /** Sends a test message now, outside the outbox, and reports the outcome code. */
  async testChannel(
    principal: Principal,
    channelId: string,
    request: RequestMetadata = NO_REQUEST_METADATA,
  ): Promise<NotificationTestResult> {
    const draft = this.auditDraft({
      principal,
      request,
      action: 'notification.channel.test',
      resourceType: 'notification_channel',
      resourceId: channelId,
    });
    return recordDenial(this.options.database, draft, async () => {
      requireGlobalAdmin(principal);
      const channel = await first<ChannelRow>(
        this.options.database,
        `SELECT ${CHANNEL_COLUMNS} FROM notification_channels WHERE id=$1`,
        [channelId],
      );
      if (!channel) notFound('通知先');
      const result = await this.sendTest(channel);
      await writeAuditEvent(this.options.database, {
        ...draft,
        projectId: channel.projectId,
        outcome: result.delivered ? 'success' : 'failed',
        details: { kind: channel.kind, error: result.error },
      });
      return result;
    });
  }

  async listRules(principal: Principal, projectId: string): Promise<NotificationRule[]> {
    await this.requireProjectAdmin(principal, projectId);
    return rows<NotificationRule>(
      this.options.database,
      `SELECT id,project_id,channel_id,event_types,filter,enabled,created_by,created_at
      FROM notification_rules WHERE project_id=$1 ORDER BY created_at DESC,id DESC`,
      [projectId],
    );
  }

  async createRule(
    principal: Principal,
    projectId: string,
    input: NotificationRuleCreateInput,
    request: RequestMetadata = NO_REQUEST_METADATA,
  ): Promise<NotificationRule> {
    const draft = this.auditDraft({
      principal,
      request,
      action: 'notification.rule.create',
      resourceType: 'notification_rule',
      projectId,
    });
    return recordDenial(this.options.database, draft, async () =>
      transaction(this.options.database, async (connection) => {
        await this.requireProjectAdmin(principal, projectId, connection);
        // FOR SHARE keeps the channel from being changed while the rule is attached to it.
        const channel = await first<{ id: string }>(
          connection,
          'SELECT id FROM notification_channels WHERE id=$1 AND (project_id IS NULL OR project_id=$2) FOR SHARE',
          [input.channelId, projectId],
        );
        if (!channel) notFound('通知先');
        const experimentIds = input.filter?.experimentIds ?? [];
        if (experimentIds.length) {
          const found = await first<{ count: number }>(
            connection,
            'SELECT count(*)::int AS count FROM experiments WHERE project_id=$1 AND id=ANY($2::uuid[])',
            [projectId, experimentIds],
          );
          if (found?.count !== new Set(experimentIds).size) notFound('Experiment');
        }
        const created = (await first<NotificationRule>(
          connection,
          `INSERT INTO notification_rules(project_id,channel_id,event_types,filter,enabled,created_by)
          VALUES($1,$2,$3,$4::jsonb,$5,$6)
          RETURNING id,project_id,channel_id,event_types,filter,enabled,created_by,created_at`,
          [
            projectId,
            input.channelId,
            input.eventTypes,
            JSON.stringify(input.filter ?? {}),
            input.enabled ?? true,
            principal.user.id,
          ],
        ))!;
        await writeAuditEvent(connection, {
          ...draft,
          resourceId: created.id,
          outcome: 'success',
          details: {
            channelId: created.channelId,
            eventTypes: created.eventTypes,
            filter: created.filter as JsonObject,
            enabled: created.enabled,
          },
        });
        return created;
      }),
    );
  }

  async updateRule(
    principal: Principal,
    projectId: string,
    request: { ruleId: string; enabled: boolean; metadata?: RequestMetadata },
  ): Promise<NotificationRule> {
    const draft = this.auditDraft({
      principal,
      request: request.metadata ?? NO_REQUEST_METADATA,
      action: 'notification.rule.update',
      resourceType: 'notification_rule',
      projectId,
      resourceId: request.ruleId,
    });
    return recordDenial(this.options.database, draft, async () =>
      transaction(this.options.database, async (connection) => {
        await this.requireProjectAdmin(principal, projectId, connection);
        const updated = await first<NotificationRule>(
          connection,
          `UPDATE notification_rules SET enabled=$3 WHERE id=$1 AND project_id=$2
          RETURNING id,project_id,channel_id,event_types,filter,enabled,created_by,created_at`,
          [request.ruleId, projectId, request.enabled],
        );
        if (!updated) notFound('通知ルール');
        await writeAuditEvent(connection, {
          ...draft,
          outcome: 'success',
          details: { enabled: updated.enabled },
        });
        return updated;
      }),
    );
  }

  async listDeliveries(
    principal: Principal,
    projectId: string,
    limit: number,
  ): Promise<NotificationDelivery[]> {
    await this.requireProjectAdmin(principal, projectId);
    return rows<NotificationDelivery>(
      this.options.database,
      `SELECT o.id,o.rule_id,o.channel_id,c.name AS channel_name,c.kind AS channel_kind,o.event_id,
        o.event_type,o.event->>'title' AS title,o.event->'run'->>'id' AS run_id,o.status,o.attempts,
        o.next_attempt_at,o.last_error,o.sent_delivery_id,o.created_at,o.delivered_at
      FROM notification_outbox o JOIN notification_channels c ON c.id=o.channel_id
      WHERE o.project_id=$1 ORDER BY o.created_at DESC,o.id DESC LIMIT $2`,
      [projectId, limit],
    );
  }

  private async sendTest(channel: ChannelRow): Promise<NotificationTestResult> {
    const sender = this.options.senders[channel.kind];
    if (!sender)
      return {
        delivered: false,
        sentDeliveryId: null,
        error: `${channel.kind}_sender_unavailable`,
      };
    try {
      const destination = resolveNotificationDestination(channel, this.options.environment);
      const { deliveryId } = await sender.send(destination, {
        schemaVersion: 1,
        id: randomUUID(),
        type: 'notification.test',
        occurredAt: new Date().toISOString(),
        title: `通知先「${channel.name}」のテスト送信です`,
        project: null,
        run: null,
        details: {},
        url: null,
      });
      return { delivered: true, sentDeliveryId: deliveryId, error: null };
    } catch (error) {
      // Unknown errors could carry the destination URL, so only known codes are shown.
      const code =
        error instanceof NotificationSendError ? error.code : 'notification_delivery_failed';
      return { delivered: false, sentDeliveryId: null, error: code };
    }
  }

  private present(channel: ChannelRow): NotificationChannel {
    return {
      ...channel,
      configured: isNotificationChannelConfigured(channel, this.options.environment),
    };
  }

  private async requireProjectAdmin(
    principal: Principal,
    projectId: string,
    connection: Connection = this.options.database,
  ): Promise<void> {
    await requireProject(connection, principal, {
      projectId,
      role: 'admin',
      scope: 'admin',
    });
  }

  private async requireProjectExists(connection: Connection, projectId: string): Promise<void> {
    const project = await first(connection, 'SELECT 1 FROM projects WHERE id=$1', [projectId]);
    if (!project) notFound('Project');
  }

  private async requireUniqueName(
    connection: Connection,
    channel: { projectId: string | null; name: string },
  ): Promise<void> {
    const existing = await first(
      connection,
      'SELECT 1 FROM notification_channels WHERE project_id IS NOT DISTINCT FROM $1 AND name=$2',
      [channel.projectId, channel.name],
    );
    if (existing)
      throw new DomainError(409, '同じ名前の通知先が既にあります', 'notification_channel_exists');
  }

  private auditDraft(entry: {
    principal: Principal;
    request: RequestMetadata;
    action: string;
    resourceType: 'notification_channel' | 'notification_rule';
    projectId?: string | null;
    resourceId?: string;
  }): AuditEventDraft {
    return {
      ...auditActor(entry.principal),
      ...entry.request,
      action: entry.action,
      resourceType: entry.resourceType,
      resourceId: entry.resourceId ?? null,
      projectId: entry.projectId ?? null,
    };
  }

  // Environment variable names are not secrets; their values and recipients are not recorded.
  private auditDetails(channel: ChannelRow): JsonObject {
    return {
      name: channel.name,
      kind: channel.kind,
      urlEnv: channel.urlEnv,
      secretEnv: channel.secretEnv,
      recipientCount: channel.recipients.length,
      enabled: channel.enabled,
    };
  }
}
