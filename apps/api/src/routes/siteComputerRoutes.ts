import { Hono } from 'hono';
import {
  siteConnectionCheckQuerySchema,
  siteConnectionCheckRequestSchema,
  siteJobShellCreateSchema,
  siteKeyRotateSchema,
  sitePersonalSettingsInputSchema,
} from '../domain/siteSettingsValidation.js';
import { jsonBody, parse, principal, uuidParam, type ApiEnvironment } from '../http/request.js';
import { requestMetadata } from '../http/requestMetadata.js';
import type { SiteConnectionCheckService } from '../services/siteConnectionCheckService.js';
import type { SiteJobShellService } from '../services/siteJobShellService.js';
import type { SiteKeyService } from '../services/siteKeyService.js';
import type { SitePersonalSettingsService } from '../services/sitePersonalSettingsService.js';
import type { TargetService } from '../services/targetService.js';

// Mounted at /api/targets: what a site has besides its ComputeTarget fields.
export function siteComputerRoutes(services: {
  targets: TargetService;
  jobShells: SiteJobShellService;
  personalSettings: SitePersonalSettingsService;
  keys: SiteKeyService;
  connectionChecks: SiteConnectionCheckService;
}): Hono<ApiEnvironment> {
  const { targets, jobShells, personalSettings, keys, connectionChecks } = services;
  const routes = new Hono<ApiEnvironment>();
  // Ahead of the /:id routes. No GET /api/targets/:id exists; one added (also in targetRoutes,
  // which is mounted first) must come after this path, or the computer ID pattern takes it.
  routes.get('/shareable-projects', async (context) =>
    context.json({ items: await targets.ownShareableProjects(principal(context)) }),
  );
  routes.get('/:id/shareable-projects', async (context) =>
    context.json({
      items: await targets.shareableProjects(principal(context), uuidParam(context, 'id')),
    }),
  );
  routes.get('/:id/job-shells', async (context) =>
    context.json({ items: await jobShells.list(principal(context), uuidParam(context, 'id')) }),
  );
  routes.get('/:id/job-shells/:shellId', async (context) =>
    context.json(
      await jobShells.get(principal(context), {
        targetId: uuidParam(context, 'id'),
        shellId: uuidParam(context, 'shellId'),
      }),
    ),
  );
  routes.post('/:id/job-shells', async (context) => {
    const { shell, created } = await jobShells.create(principal(context), uuidParam(context, 'id'), {
      content: (await jsonBody(context, siteJobShellCreateSchema)).content,
      metadata: requestMetadata(context),
    });
    return context.json(shell, created ? 201 : 200);
  });
  routes.get('/:id/personal-settings', async (context) =>
    context.json({
      items: await personalSettings.listAll(principal(context), uuidParam(context, 'id')),
    }),
  );
  routes.get('/:id/personal-settings/me', async (context) =>
    context.json({
      item: await personalSettings.getOwn(principal(context), uuidParam(context, 'id')),
    }),
  );
  routes.put('/:id/personal-settings/me', async (context) =>
    context.json(
      await personalSettings.saveOwn(principal(context), uuidParam(context, 'id'), {
        input: await jsonBody(context, sitePersonalSettingsInputSchema),
        metadata: requestMetadata(context),
      }),
    ),
  );
  routes.delete('/:id/personal-settings/me', async (context) => {
    await personalSettings.deleteOwn(
      principal(context),
      uuidParam(context, 'id'),
      requestMetadata(context),
    );
    return context.body(null, 204);
  });
  routes.get('/:id/keys', async (context) =>
    context.json({ items: await keys.list(principal(context), uuidParam(context, 'id')) }),
  );
  routes.post('/:id/keys/rotate', async (context) =>
    context.json(
      await keys.rotate(principal(context), uuidParam(context, 'id'), {
        personal: (await jsonBody(context, siteKeyRotateSchema)).personal,
        metadata: requestMetadata(context),
      }),
    ),
  );
  routes.post('/:id/connection-checks', async (context) =>
    context.json(
      await connectionChecks.request(
        principal(context),
        uuidParam(context, 'id'),
        await jsonBody(context, siteConnectionCheckRequestSchema),
      ),
      201,
    ),
  );
  routes.get('/:id/connection-checks', async (context) =>
    context.json({
      items: await connectionChecks.list(principal(context), uuidParam(context, 'id'), {
        personal: parse(siteConnectionCheckQuerySchema, context.req.query()).personal === 'true',
      }),
    }),
  );
  return routes;
}
