import { Hono } from 'hono';
import {
  childJobCreateSchema,
  childJobWaitQuerySchema,
  hookCreateSchema,
  hookExecutionQuerySchema,
  hookToggleSchema,
  hookTriggerRequestSchema,
} from '../domain/hookValidation.js';
import {
  jsonBody,
  parse,
  principal,
  uuidParam,
  type ApiEnvironment,
} from '../http/request.js';
import type { ChildJobService } from '../services/childJobService.js';
import type { HookService } from '../services/hookService.js';

// Mounted at /api/projects.
export function hookRoutes(hooks: HookService): Hono<ApiEnvironment> {
  const routes = new Hono<ApiEnvironment>();
  routes.get('/:p/hooks', async (context) =>
    context.json({ items: await hooks.list(principal(context), uuidParam(context, 'p')) }),
  );
  routes.post('/:p/hooks', async (context) =>
    context.json(
      await hooks.create(
        principal(context),
        uuidParam(context, 'p'),
        await jsonBody(context, hookCreateSchema),
      ),
      201,
    ),
  );
  routes.patch('/:p/hooks/:id', async (context) =>
    context.json(
      await hooks.toggle(principal(context), uuidParam(context, 'p'), {
        hookId: uuidParam(context, 'id'),
        ...(await jsonBody(context, hookToggleSchema)),
      }),
    ),
  );
  routes.post('/:p/hooks/:id/trigger', async (context) =>
    context.json(
      await hooks.trigger(principal(context), uuidParam(context, 'p'), {
        hookId: uuidParam(context, 'id'),
        ...(await jsonBody(context, hookTriggerRequestSchema)),
      }),
      201,
    ),
  );
  routes.get('/:p/hook-executions', async (context) =>
    context.json(
      await hooks.executions(
        principal(context),
        uuidParam(context, 'p'),
        parse(hookExecutionQuerySchema, context.req.query()),
      ),
    ),
  );
  return routes;
}

// Mounted at /api: no session or token; the delivery's signature is checked instead.
export function webhookRoutes(hooks: HookService): Hono<ApiEnvironment> {
  const routes = new Hono<ApiEnvironment>();
  routes.post('/hooks/:id/webhook', async (context) =>
    context.json(
      await hooks.receiveWebhook({
        hookId: uuidParam(context, 'id'),
        header: (name) => context.req.header(name),
        body: Buffer.from(await context.req.arrayBuffer()),
      }),
      202,
    ),
  );
  return routes;
}

// Mounted at /api/projects: a driver Job's code with its Job token.
export function childJobRoutes(children: ChildJobService): Hono<ApiEnvironment> {
  const routes = new Hono<ApiEnvironment>();
  routes.post('/:p/jobs/:j/children', async (context) => {
    const created = await children.create(
      principal(context),
      { projectId: uuidParam(context, 'p'), jobId: uuidParam(context, 'j') },
      await jsonBody(context, childJobCreateSchema),
    );
    return context.json(created, created.created ? 201 : 200);
  });
  routes.get('/:p/jobs/:j/children', async (context) =>
    context.json({
      items: await children.list(principal(context), {
        projectId: uuidParam(context, 'p'),
        jobId: uuidParam(context, 'j'),
      }),
    }),
  );
  routes.get('/:p/jobs/:j/children/wait', async (context) =>
    context.json(
      await children.wait(principal(context), {
        projectId: uuidParam(context, 'p'),
        jobId: uuidParam(context, 'j'),
        ...parse(childJobWaitQuerySchema, context.req.query()),
      }),
    ),
  );
  return routes;
}
