import type {
  ArtifactBackend,
  Experiment,
  Project,
  ProjectMember,
  ProjectRole,
} from '@mmt/contracts';
import type { Principal } from '../auth/principal.js';
import { first, rows, transaction, type Database } from '../db/database.js';
import { conflict, DomainError, notFound } from '../domain/errors.js';
import { removesLastProjectAdmin } from '../domain/projectAdminInvariant.js';
import type { RequestMetadata } from '../http/requestMetadata.js';
import { writeAuditEvent } from '../repositories/auditRepository.js';
import {
  findDirectRole,
  findMember,
  findUser,
  listMembers,
  lockProjectAdminGrants,
} from '../repositories/identityRepository.js';
import { requireProject, requireScope } from './accessService.js';
import {
  auditActor,
  NO_REQUEST_METADATA,
  recordDenial,
  type AuditEventDraft,
} from './auditService.js';

export class ProjectService {
  constructor(
    private readonly database: Database,
    private readonly backends: () => ArtifactBackend[],
  ) {}

  async list(principal: Principal): Promise<Project[]> {
    requireScope(principal, 'read');
    return rows<Project>(
      this.database,
      `SELECT p.*,COALESCE(e.role,'admin') AS role FROM projects p
      LEFT JOIN effective_project_roles e ON e.project_id=p.id AND e.user_id=$1
      WHERE (e.role IS NOT NULL OR $2) AND ($3::uuid IS NULL OR p.id=$3) ORDER BY p.created_at DESC`,
      [
        principal.user.id,
        principal.method === 'session' && principal.user.isAdmin,
        principal.token?.projectId ?? null,
      ],
    );
  }

  async create(
    principal: Principal,
    input: { name: string; description: string; artifactBackend: ArtifactBackend },
  ): Promise<Project> {
    requireScope(principal, 'admin');
    if (principal.token?.projectId)
      throw new DomainError(
        403,
        'Project限定tokenではProjectを作成できません',
        'project_forbidden',
      );
    this.validateBackend(input.artifactBackend);
    return transaction(this.database, async (connection) => {
      const project = (await first<Omit<Project, 'role'>>(
        connection,
        'INSERT INTO projects(name,description,artifact_backend) VALUES($1,$2,$3) RETURNING *',
        [input.name, input.description, input.artifactBackend],
      ))!;
      await connection.query(
        "INSERT INTO project_members(project_id,user_id,role) VALUES($1,$2,'admin')",
        [project.id, principal.user.id],
      );
      return { ...project, role: 'admin' };
    });
  }

  async patch(
    principal: Principal,
    projectId: string,
    input: { description?: string; artifactBackend?: ArtifactBackend },
  ): Promise<Project> {
    return transaction(this.database, async (connection) => {
      const role = await requireProject(connection, principal, {
        projectId,
        role: 'admin',
        scope: 'admin',
      });
      if (input.artifactBackend) this.validateBackend(input.artifactBackend);
      const project = await first<Omit<Project, 'role'>>(
        connection,
        'UPDATE projects SET description=COALESCE($2,description),artifact_backend=COALESCE($3,artifact_backend) WHERE id=$1 RETURNING *',
        [projectId, input.description, input.artifactBackend],
      );
      return { ...project!, role };
    });
  }

  async members(principal: Principal, projectId: string): Promise<ProjectMember[]> {
    await requireProject(this.database, principal, { projectId, role: 'viewer', scope: 'read' });
    return listMembers(this.database, projectId);
  }

  // Sets the direct grant only; group bindings are managed by ProjectGroupBindingService.
  async setMember(
    principal: Principal,
    membership: { projectId: string; userId: string; role: ProjectRole },
    request: RequestMetadata = NO_REQUEST_METADATA,
  ): Promise<ProjectMember> {
    const { projectId, userId, role } = membership;
    const draft: AuditEventDraft = {
      ...auditActor(principal),
      ...request,
      action: 'project.member.set',
      resourceType: 'project_member',
      resourceId: userId,
      projectId,
      details: { userId, role },
    };
    return recordDenial(this.database, draft, () =>
      transaction(this.database, async (connection) => {
        await requireProject(connection, principal, { projectId, role: 'admin', scope: 'admin' });
        const adminGrants = await lockProjectAdminGrants(connection, projectId);
        const user = await findUser(connection, userId);
        if (!user) notFound('User');
        const previousRole = await findDirectRole(connection, { projectId, userId });
        if (removesLastProjectAdmin(adminGrants, { kind: 'member', userId, role }))
          conflict('最後のProject管理者は権限を下げられません');
        await connection.query(
          'INSERT INTO project_members(project_id,user_id,role) VALUES($1,$2,$3) ON CONFLICT(project_id,user_id) DO UPDATE SET role=EXCLUDED.role',
          [projectId, userId, role],
        );
        await writeAuditEvent(connection, {
          ...draft,
          outcome: 'success',
          details: { userId, previousRole, role },
        });
        return (await findMember(connection, { projectId, userId }))!;
      }),
    );
  }

  // Removes the direct grant. A user who also holds a bound group keeps that role.
  async removeMember(
    principal: Principal,
    membership: { projectId: string; userId: string },
    request: RequestMetadata = NO_REQUEST_METADATA,
  ): Promise<void> {
    const { projectId, userId } = membership;
    const draft: AuditEventDraft = {
      ...auditActor(principal),
      ...request,
      action: 'project.member.delete',
      resourceType: 'project_member',
      resourceId: userId,
      projectId,
      details: { userId },
    };
    await recordDenial(this.database, draft, () =>
      transaction(this.database, async (connection) => {
        await requireProject(connection, principal, { projectId, role: 'admin', scope: 'admin' });
        const adminGrants = await lockProjectAdminGrants(connection, projectId);
        const previousRole = await findDirectRole(connection, { projectId, userId });
        if (!previousRole) notFound('Projectメンバー');
        if (removesLastProjectAdmin(adminGrants, { kind: 'member', userId, role: null }))
          conflict('最後のProject管理者は外せません');
        await connection.query('DELETE FROM project_members WHERE project_id=$1 AND user_id=$2', [
          projectId,
          userId,
        ]);
        await writeAuditEvent(connection, {
          ...draft,
          outcome: 'success',
          details: { userId, previousRole },
        });
      }),
    );
  }

  async experiments(principal: Principal, projectId: string): Promise<Experiment[]> {
    await requireProject(this.database, principal, { projectId, role: 'viewer', scope: 'read' });
    return rows<Experiment>(
      this.database,
      "SELECT e.*, (SELECT count(*) FROM runs r WHERE r.experiment_id=e.id AND r.lifecycle_stage='active') AS run_count FROM experiments e WHERE project_id=$1 AND e.lifecycle_stage='active' ORDER BY e.created_at DESC",
      [projectId],
    );
  }

  async createExperiment(
    principal: Principal,
    projectId: string,
    input: { name: string; description: string },
  ): Promise<Experiment> {
    return transaction(this.database, async (connection) => {
      await requireProject(connection, principal, {
        projectId,
        role: 'editor',
        scope: 'runs:write',
      });
      // SDK creation and rename also lock the Project to keep names unambiguous.
      await connection.query('SELECT id FROM projects WHERE id=$1 FOR UPDATE', [projectId]);
      const duplicate = await first(
        connection,
        'SELECT id FROM experiments WHERE project_id=$1 AND name=$2',
        [projectId, input.name],
      );
      if (duplicate)
        throw new DomainError(409, '同名Experimentが既に存在します', 'resource_already_exists');
      return (await first<Experiment>(
        connection,
        'INSERT INTO experiments(project_id,name,description) VALUES($1,$2,$3) RETURNING *,0 AS run_count',
        [projectId, input.name, input.description],
      ))!;
    });
  }

  private validateBackend(backend: ArtifactBackend): void {
    if (!this.backends().includes(backend))
      throw new DomainError(422, 'Artifact保存先が設定されていません', 'backend_unavailable');
  }
}
