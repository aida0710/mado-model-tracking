import type { Database } from '../db/database.js';

// Stub for wave 1: auth-audit-events adds the listing and authorization methods.
export class AuditService {
  constructor(readonly database: Database) {}
}
