import type { Principal } from '../../auth/principal.js';
import type { Connection } from '../../db/database.js';
import { requireProject } from '../../services/accessService.js';

export function requireModelsRead(
  connection: Connection,
  access: { principal: Principal; projectId: string },
) {
  return requireProject(connection, access.principal, {
    projectId: access.projectId,
    role: 'viewer',
    scope: 'read',
  });
}
export function requireModelsWrite(
  connection: Connection,
  access: { principal: Principal; projectId: string },
) {
  return requireProject(connection, access.principal, {
    projectId: access.projectId,
    role: 'editor',
    scope: 'registry:write',
  });
}
