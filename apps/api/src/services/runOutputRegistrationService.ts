import type { RunOutputRegistration } from '@mmt/contracts';
import type { Principal } from '../auth/principal.js';
import type { Database } from '../db/database.js';
import { DomainError } from '../domain/errors.js';
import { findRun } from '../repositories/registryRepository.js';
import { findRunOutputRegistration } from '../repositories/runOutputRegistrationRepository.js';
import { requireProject } from './accessService.js';

export class RunOutputRegistrationService {
  constructor(private readonly database: Database) {}

  // A Run without a record either has no Task output setting or has not finished yet; the Run's
  // own outputModelRegistration tells the two apart.
  async get(
    principal: Principal,
    reference: { projectId: string; runId: string },
  ): Promise<RunOutputRegistration> {
    const { projectId, runId } = reference;
    await requireProject(this.database, principal, { projectId, role: 'viewer', scope: 'read' });
    await findRun(this.database, { projectId, id: runId });
    const registration = await findRunOutputRegistration(this.database, { projectId, runId });
    if (!registration)
      throw new DomainError(
        404,
        'Taskの出力モデル登録の記録がありません',
        'output_registration_not_found',
      );
    return registration;
  }
}
