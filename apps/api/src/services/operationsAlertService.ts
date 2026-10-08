import type { OperationsAlert, OperationsAlertState } from '@mmt/contracts';
import type { Principal } from '../auth/principal.js';
import type { Database } from '../db/database.js';
import { listProjectAlerts } from '../repositories/operationsAlertRepository.js';
import { requireProject } from './accessService.js';

/** Reads the alerts OperationsMonitor keeps; every Project member may see them. */
export class OperationsAlertService {
  constructor(private readonly database: Database) {}

  async list(
    principal: Principal,
    projectId: string,
    filter: { state: OperationsAlertState; limit: number },
  ): Promise<OperationsAlert[]> {
    await requireProject(this.database, principal, { projectId, role: 'viewer', scope: 'read' });
    return listProjectAlerts(this.database, { projectId, ...filter });
  }
}
