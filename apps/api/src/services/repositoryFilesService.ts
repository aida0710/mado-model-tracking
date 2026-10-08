import type { RepositoryFiles } from '@mmt/contracts';
import type { Principal } from '../auth/principal.js';
import type { Database } from '../db/database.js';
import type { RepositoryFilesRequest } from '../domain/codeSourceValidation.js';
import { requireProject } from './accessService.js';
import type { RepositoryReader } from './repositoryReader.js';

export class RepositoryFilesService {
  constructor(
    private readonly database: Database,
    private readonly readRepository: RepositoryReader,
  ) {}

  async read(
    principal: Principal,
    projectId: string,
    request: RepositoryFilesRequest,
  ): Promise<RepositoryFiles> {
    await requireProject(this.database, principal, {
      projectId,
      role: 'editor',
      scope: 'registry:write',
    });
    return this.readRepository(request);
  }
}
