import { Hono } from 'hono';
import { z } from 'zod';
import type { ProjectService } from '../services/projectService.js';
import {
  namedEntitySchema,
  projectCreateSchema,
  projectPatchSchema,
  roleSchema,
} from '../domain/validation.js';
import { jsonBody, principal, uuidParam, type ApiEnvironment } from '../http/request.js';

export function projectRoutes(projects: ProjectService): Hono<ApiEnvironment> {
  const routes = new Hono<ApiEnvironment>();
  routes.get('/', async (context) =>
    context.json({ items: await projects.list(principal(context)) }),
  );
  routes.post('/', async (context) =>
    context.json(
      await projects.create(principal(context), await jsonBody(context, projectCreateSchema)),
      201,
    ),
  );
  routes.patch('/:p', async (context) =>
    context.json(
      await projects.patch(
        principal(context),
        uuidParam(context, 'p'),
        await jsonBody(context, projectPatchSchema),
      ),
    ),
  );
  routes.get('/:p/members', async (context) => {
    const members = await projects.members(principal(context), uuidParam(context, 'p'));
    return context.json({ items: members.map(({ role, ...user }) => ({ user, role })) });
  });
  routes.put('/:p/members/:userId', async (context) => {
    const input = await jsonBody(context, z.strictObject({ role: roleSchema }));
    const { role, ...user } = await projects.setMember(
      principal(context),
      uuidParam(context, 'p'),
      { userId: uuidParam(context, 'userId'), role: input.role },
    );
    return context.json({ user, role });
  });
  routes.get('/:p/experiments', async (context) =>
    context.json({
      items: await projects.experiments(principal(context), uuidParam(context, 'p')),
    }),
  );
  routes.post('/:p/experiments', async (context) =>
    context.json(
      await projects.createExperiment(
        principal(context),
        uuidParam(context, 'p'),
        await jsonBody(context, namedEntitySchema),
      ),
      201,
    ),
  );
  return routes;
}
