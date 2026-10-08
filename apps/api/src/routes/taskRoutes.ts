import { Hono } from 'hono';
import {
  taskCreateSchema,
  taskHistoryQuerySchema,
  taskLaunchSchema,
  taskPatchSchema,
} from '../domain/experimentTaskValidation.js';
import { uuidSchema } from '../domain/validation.js';
import { jsonBody, parse, principal, uuidParam, type ApiEnvironment } from '../http/request.js';
import type { TaskService } from '../services/taskService.js';

export function taskRoutes(tasks: TaskService): Hono<ApiEnvironment> {
  const routes = new Hono<ApiEnvironment>();
  routes.get('/:p/tasks', async (context) =>
    context.json({
      items: await tasks.list(
        principal(context),
        uuidParam(context, 'p'),
        context.req.query('experimentId') === undefined
          ? undefined
          : parse(uuidSchema, context.req.query('experimentId')),
      ),
    }),
  );
  routes.post('/:p/tasks', async (context) =>
    context.json(
      await tasks.create(
        principal(context),
        uuidParam(context, 'p'),
        await jsonBody(context, taskCreateSchema),
      ),
      201,
    ),
  );
  routes.get('/:p/tasks/:id', async (context) =>
    context.json(
      await tasks.get(principal(context), uuidParam(context, 'p'), uuidParam(context, 'id')),
    ),
  );
  routes.patch('/:p/tasks/:id', async (context) =>
    context.json(
      await tasks.patch(principal(context), uuidParam(context, 'p'), {
        taskId: uuidParam(context, 'id'),
        input: await jsonBody(context, taskPatchSchema),
      }),
    ),
  );
  routes.post('/:p/tasks/:id/launch', async (context) =>
    context.json(
      await tasks.launch(principal(context), uuidParam(context, 'p'), {
        taskId: uuidParam(context, 'id'),
        input: await jsonBody(context, taskLaunchSchema),
      }),
      201,
    ),
  );
  routes.get('/:p/tasks/:id/runs', async (context) => {
    const query = parse(taskHistoryQuerySchema, context.req.query());
    return context.json(
      await tasks.history(principal(context), uuidParam(context, 'p'), {
        taskId: uuidParam(context, 'id'),
        ...query,
      }),
    );
  });
  return routes;
}
