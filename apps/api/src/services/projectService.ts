import type { ArtifactBackend, Experiment, Project, ProjectRole, User } from '@mmt/contracts';
import type { Principal } from '../auth/principal.js';
import { first, rows, transaction, type Database } from '../db/database.js';
import { conflict, DomainError, notFound } from '../domain/errors.js';
import { findUser, listMembers } from '../repositories/identityRepository.js';
import { requireProject, requireScope } from './accessService.js';

export class ProjectService {
  constructor(
    private readonly database: Database,
    private readonly backends: () => ArtifactBackend[],
  ) {}

  async list(principal: Principal): Promise<Project[]> {
    requireScope(principal, 'read');
    return rows<Project>(
      this.database,
      `SELECT p.*,COALESCE(m.role,'admin') AS role FROM projects p
      LEFT JOIN project_members m ON m.project_id=p.id AND m.user_id=$1
      WHERE (m.role IS NOT NULL OR $2) AND ($3::uuid IS NULL OR p.id=$3) ORDER BY p.created_at DESC`,
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

  async members(principal: Principal, projectId: string): Promise<(User & { role: string })[]> {
    await requireProject(this.database, principal, { projectId, role: 'viewer', scope: 'read' });
    return listMembers(this.database, projectId);
  }

  async setMember(
    principal: Principal,
    projectId: string,
    member: { userId: string; role: ProjectRole },
  ): Promise<User & { role: ProjectRole }> {
    return transaction(this.database, async (connection) => {
      await requireProject(connection, principal, { projectId, role: 'admin', scope: 'admin' });
      // Serialize membership edits so the last administrator cannot be removed concurrently.
      await connection.query('SELECT id FROM projects WHERE id=$1 FOR UPDATE', [projectId]);
      const user = await findUser(connection, member.userId);
      if (!user) notFound('User');
      const previous = await first<{ role: ProjectRole }>(
        connection,
        'SELECT role FROM project_members WHERE project_id=$1 AND user_id=$2',
        [projectId, member.userId],
      );
      if (previous?.role === 'admin' && member.role !== 'admin') {
        const administrators = await rows<{ userId: string }>(
          connection,
          "SELECT user_id FROM project_members WHERE project_id=$1 AND role='admin'",
          [projectId],
        );
        if (administrators.length <= 1) conflict('最後のProject管理者は権限を下げられません');
      }
      await connection.query(
        'INSERT INTO project_members(project_id,user_id,role) VALUES($1,$2,$3) ON CONFLICT(project_id,user_id) DO UPDATE SET role=EXCLUDED.role',
        [projectId, member.userId, member.role],
      );
      return { ...user, role: member.role };
    });
  }

  async experiments(principal: Principal, projectId: string): Promise<Experiment[]> {
    await requireProject(this.database, principal, { projectId, role: 'viewer', scope: 'read' });
    return rows<Experiment>(
      this.database,
      'SELECT e.*, (SELECT count(*) FROM runs r WHERE r.experiment_id=e.id) AS run_count FROM experiments e WHERE project_id=$1 ORDER BY e.created_at DESC',
      [projectId],
    );
  }

  async createExperiment(
    principal: Principal,
    projectId: string,
    input: { name: string; description: string },
  ): Promise<Experiment> {
    await requireProject(this.database, principal, {
      projectId,
      role: 'editor',
      scope: 'runs:write',
    });
    return (await first<Experiment>(
      this.database,
      'INSERT INTO experiments(project_id,name,description) VALUES($1,$2,$3) RETURNING *,0 AS run_count',
      [projectId, input.name, input.description],
    ))!;
  }

  private validateBackend(backend: ArtifactBackend): void {
    if (!this.backends().includes(backend))
      throw new DomainError(422, 'Artifact保存先が設定されていません', 'backend_unavailable');
  }
}
