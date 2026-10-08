import { Hono } from 'hono';
import {
  reportCreateSchema,
  reportListQuerySchema,
  reportRestoreSchema,
  reportRevisionQuerySchema,
  reportUpdateSchema,
} from '../domain/reportBlocks.js';
import {
  jsonBody,
  parse,
  principal,
  uuidParam,
  type ApiContext,
  type ApiEnvironment,
} from '../http/request.js';
import { requestMetadata } from '../http/requestMetadata.js';
import type { ReportService } from '../services/reportService.js';

function reportReference(context: ApiContext) {
  return { projectId: uuidParam(context, 'p'), reportId: uuidParam(context, 'reportId') };
}

export function reportRoutes(reports: ReportService): Hono<ApiEnvironment> {
  const routes = new Hono<ApiEnvironment>();
  routes.get('/:p/reports', async (context) =>
    context.json(
      await reports.list(
        principal(context),
        uuidParam(context, 'p'),
        parse(reportListQuerySchema, context.req.query()),
      ),
    ),
  );
  routes.post('/:p/reports', async (context) =>
    context.json(
      await reports.create(
        principal(context),
        uuidParam(context, 'p'),
        await jsonBody(context, reportCreateSchema),
        requestMetadata(context),
      ),
      201,
    ),
  );
  routes.get('/:p/reports/:reportId', async (context) =>
    context.json(
      await reports.get(principal(context), {
        ...reportReference(context),
        ...parse(reportRevisionQuerySchema, context.req.query()),
      }),
    ),
  );
  routes.put('/:p/reports/:reportId', async (context) =>
    context.json(
      await reports.update(
        principal(context),
        { ...reportReference(context), update: await jsonBody(context, reportUpdateSchema) },
        requestMetadata(context),
      ),
    ),
  );
  routes.get('/:p/reports/:reportId/revisions', async (context) =>
    context.json(await reports.listRevisions(principal(context), reportReference(context))),
  );
  routes.get('/:p/reports/:reportId/snapshots', async (context) =>
    context.json(
      await reports.listSnapshots(principal(context), {
        ...reportReference(context),
        ...parse(reportRevisionQuerySchema, context.req.query()),
      }),
    ),
  );
  routes.post('/:p/reports/:reportId/restore', async (context) =>
    context.json(
      await reports.restore(
        principal(context),
        { ...reportReference(context), ...(await jsonBody(context, reportRestoreSchema)) },
        requestMetadata(context),
      ),
      201,
    ),
  );
  routes.post('/:p/reports/:reportId/archive', async (context) =>
    context.json(
      await reports.archive(principal(context), reportReference(context), requestMetadata(context)),
    ),
  );
  routes.post('/:p/reports/:reportId/unarchive', async (context) =>
    context.json(
      await reports.unarchive(
        principal(context),
        reportReference(context),
        requestMetadata(context),
      ),
    ),
  );
  return routes;
}
