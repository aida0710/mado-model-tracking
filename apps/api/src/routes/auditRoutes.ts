import { Hono } from 'hono';
import type { AuditService } from '../services/auditService.js';
import type { ApiEnvironment } from '../http/request.js';

// Mounted at /api so the owner can serve both /audit-events and /projects/:p/audit-events.
export function auditRoutes(_audit: AuditService): Hono<ApiEnvironment> {
  return new Hono<ApiEnvironment>();
}
