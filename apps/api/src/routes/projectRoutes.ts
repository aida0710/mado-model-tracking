import { Hono } from 'hono';
import type { ProjectGroupBindingService } from '../services/projectGroupBindingService.js';
import type { ProjectService } from '../services/projectService.js';
import type { TokenService } from '../services/tokenService.js';
import {
  groupNameSchema,
  namedEntitySchema,
  projectCreateSchema,
  projectPatchSchema,
  roleAssignmentSchema,
} from '../domain/validation.js';
import { jsonBody, parse, principal, uuidParam, type ApiEnvironment } from '../http/request.js';
import { requestMetadata } from '../http/requestMetadata.js';

export function projectRoutes(
  projects: ProjectService,
  groupBindings: ProjectGroupBindingService,
  tokens: TokenService,
): Hono<ApiEnvironment> {
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
  routes.get('/:p/members', async (context) =>
    context.json({ items: await projects.members(principal(context), uuidParam(context, 'p')) }),
  );
  routes.put('/:p/members/:userId', async (context) => {
    const input = await jsonBody(context, roleAssignmentSchema);
    return context.json(
      await projects.setMember(
        principal(context),
        {
          projectId: uuidParam(context, 'p'),
          userId: uuidParam(context, 'userId'),
          role: input.role,
        },
        requestMetadata(context),
      ),
    );
  });
  routes.delete('/:p/members/:userId', async (context) => {
    await projects.removeMember(
      principal(context),
      { projectId: uuidParam(context, 'p'), userId: uuidParam(context, 'userId') },
      requestMetadata(context),
    );
    return context.body(null, 204);
  });
  routes.get('/:p/group-bindings', async (context) =>
    context.json({
      items: await groupBindings.list(principal(context), uuidParam(context, 'p')),
    }),
  );
  routes.put('/:p/group-bindings/:group', async (context) => {
    const input = await jsonBody(context, roleAssignmentSchema);
    return context.json(
      await groupBindings.set(
        principal(context),
        {
          projectId: uuidParam(context, 'p'),
          group: parse(groupNameSchema, context.req.param('group')),
          role: input.role,
        },
        requestMetadata(context),
      ),
    );
  });
  routes.delete('/:p/group-bindings/:group', async (context) => {
    await groupBindings.delete(
      principal(context),
      {
        projectId: uuidParam(context, 'p'),
        group: parse(groupNameSchema, context.req.param('group')),
      },
      requestMetadata(context),
    );
    return context.body(null, 204);
  });
  routes.get('/:p/tokens', async (context) =>
    context.json({ items: await tokens.listProject(principal(context), uuidParam(context, 'p')) }),
  );
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
