import { Hono } from 'hono';
import {
  sweepCancelSchema,
  sweepCreateSchema,
  sweepListQuerySchema,
  sweepPatchSchema,
  sweepTrialQuerySchema,
} from '../domain/sweepValidation.js';
import { jsonBody, parse, principal, uuidParam, type ApiContext, type ApiEnvironment } from '../http/request.js';
import { requestMetadata } from '../http/requestMetadata.js';
import type { SweepService } from '../services/sweepService.js';

function sweepReference(context: ApiContext) {
  return { projectId: uuidParam(context, 'p'), sweepId: uuidParam(context, 's') };
}

export function sweepRoutes(sweeps: SweepService): Hono<ApiEnvironment> {
  const routes = new Hono<ApiEnvironment>();
  routes.get('/:p/sweeps', async (context) =>
    context.json(
      await sweeps.list(
        principal(context),
        uuidParam(context, 'p'),
        parse(sweepListQuerySchema, context.req.query()),
      ),
    ),
  );
  routes.post('/:p/sweeps', async (context) =>
    context.json(
      await sweeps.create(
        principal(context),
        uuidParam(context, 'p'),
        await jsonBody(context, sweepCreateSchema),
        requestMetadata(context),
      ),
      201,
    ),
  );
  routes.get('/:p/sweeps/:s', async (context) =>
    context.json(await sweeps.get(principal(context), sweepReference(context))),
  );
  routes.patch('/:p/sweeps/:s', async (context) =>
    context.json(
      await sweeps.patch(
        principal(context),
        { ...sweepReference(context), input: await jsonBody(context, sweepPatchSchema) },
        requestMetadata(context),
      ),
    ),
  );
  routes.get('/:p/sweeps/:s/trials', async (context) =>
    context.json(
      await sweeps.trials(principal(context), {
        ...sweepReference(context),
        ...parse(sweepTrialQuerySchema, context.req.query()),
      }),
    ),
  );
  routes.post('/:p/sweeps/:s/pause', async (context) =>
    context.json(
      await sweeps.pause(principal(context), sweepReference(context), requestMetadata(context)),
    ),
  );
  routes.post('/:p/sweeps/:s/resume', async (context) =>
    context.json(
      await sweeps.resume(principal(context), sweepReference(context), requestMetadata(context)),
    ),
  );
  routes.post('/:p/sweeps/:s/cancel', async (context) =>
    context.json(
      await sweeps.cancel(
        principal(context),
        { ...sweepReference(context), ...(await jsonBody(context, sweepCancelSchema)) },
        requestMetadata(context),
      ),
    ),
  );
  return routes;
}
