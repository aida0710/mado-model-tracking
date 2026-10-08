import { Hono } from 'hono';
import type { AuditService } from '../services/auditService.js';
import { auditEventQuerySchema, projectAuditEventQuerySchema } from '../domain/auditValidation.js';
import { parse, principal, uuidParam, type ApiEnvironment } from '../http/request.js';

// Mounted at /api so both the global and the Project-scoped listings live here.
export function auditRoutes(audit: AuditService): Hono<ApiEnvironment> {
  const routes = new Hono<ApiEnvironment>();
  routes.get('/audit-events', async (context) =>
    context.json(
      await audit.list(principal(context), parse(auditEventQuerySchema, context.req.query())),
    ),
  );
  routes.get('/projects/:p/audit-events', async (context) =>
    context.json(
      await audit.listForProject(
        principal(context),
        uuidParam(context, 'p'),
        parse(projectAuditEventQuerySchema, context.req.query()),
      ),
    ),
  );
  return routes;
}
