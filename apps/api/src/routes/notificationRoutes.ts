import { Hono } from 'hono';
import {
  notificationChannelCreateSchema,
  notificationChannelPatchSchema,
  notificationDeliveryQuerySchema,
  notificationRuleCreateSchema,
  notificationRulePatchSchema,
} from '../domain/notificationValidation.js';
import { jsonBody, parse, principal, uuidParam, type ApiEnvironment } from '../http/request.js';
import { requestMetadata } from '../http/requestMetadata.js';
import type { NotificationService } from '../services/notificationService.js';

/** Mounted at /api: channels are global (/notification-channels), rules belong to a Project. */
export function notificationRoutes(notifications: NotificationService): Hono<ApiEnvironment> {
  const routes = new Hono<ApiEnvironment>();
  routes.get('/notification-channels', async (context) =>
    context.json({ items: await notifications.listChannels(principal(context)) }),
  );
  routes.post('/notification-channels', async (context) =>
    context.json(
      await notifications.createChannel(
        principal(context),
        await jsonBody(context, notificationChannelCreateSchema),
        requestMetadata(context),
      ),
      201,
    ),
  );
  routes.patch('/notification-channels/:channelId', async (context) =>
    context.json(
      await notifications.updateChannel(
        principal(context),
        uuidParam(context, 'channelId'),
        await jsonBody(context, notificationChannelPatchSchema),
        requestMetadata(context),
      ),
    ),
  );
  routes.post('/notification-channels/:channelId/test', async (context) =>
    context.json(
      await notifications.testChannel(
        principal(context),
        uuidParam(context, 'channelId'),
        requestMetadata(context),
      ),
    ),
  );
  routes.get('/projects/:projectId/notification-channels', async (context) =>
    context.json({
      items: await notifications.listProjectChannels(
        principal(context),
        uuidParam(context, 'projectId'),
      ),
    }),
  );
  routes.get('/projects/:projectId/notification-rules', async (context) =>
    context.json({
      items: await notifications.listRules(principal(context), uuidParam(context, 'projectId')),
    }),
  );
  routes.post('/projects/:projectId/notification-rules', async (context) =>
    context.json(
      await notifications.createRule(
        principal(context),
        uuidParam(context, 'projectId'),
        await jsonBody(context, notificationRuleCreateSchema),
        requestMetadata(context),
      ),
      201,
    ),
  );
  routes.patch('/projects/:projectId/notification-rules/:ruleId', async (context) => {
    const { enabled } = await jsonBody(context, notificationRulePatchSchema);
    return context.json(
      await notifications.updateRule(principal(context), uuidParam(context, 'projectId'), {
        ruleId: uuidParam(context, 'ruleId'),
        enabled,
        metadata: requestMetadata(context),
      }),
    );
  });
  routes.get('/projects/:projectId/notification-deliveries', async (context) => {
    const { limit } = parse(notificationDeliveryQuerySchema, context.req.query());
    return context.json({
      items: await notifications.listDeliveries(
        principal(context),
        uuidParam(context, 'projectId'),
        limit,
      ),
    });
  });
  return routes;
}
