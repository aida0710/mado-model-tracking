import type {
  ArtifactBackend,
  Experiment,
  Project,
  ProjectMember,
  ProjectMemberGrant,
  ProjectRole,
} from '@mmt/contracts';
import type { Principal } from '../auth/principal.js';
import { first, rows, transaction, type Connection, type Database } from '../db/database.js';
import { conflict, DomainError, notFound } from '../domain/errors.js';
import { removesLastProjectAdmin } from '../domain/projectAdminInvariant.js';
import { assertGrantableUsers, initialMemberGrants } from '../domain/projectMemberGrants.js';
import type { ProjectCreateInput, ProjectPatchInput } from '../domain/projectValidation.js';
import type { ExperimentPatch } from '../domain/registryLifecycleValidation.js';
import type { RequestMetadata } from '../http/requestMetadata.js';
import { writeAuditEvent } from '../repositories/auditRepository.js';
import {
  findDirectRole,
  findMember,
  findUser,
  listMembers,
  listUserStates,
  lockProjectAdminGrants,
} from '../repositories/identityRepository.js';
import {
  archiveProject,
  hasActiveJobs,
  insertProject,
  lockProjectLifecycle,
  PROJECT_COLUMNS,
  updateProject,
} from '../repositories/projectRepository.js';
import { requireProject, requireScope } from './accessService.js';
import {
  auditActor,
  NO_REQUEST_METADATA,
  recordDenial,
  type AuditEventDraft,
} from './auditService.js';

const experimentSelect =
  "SELECT e.*, (SELECT count(*) FROM runs r WHERE r.experiment_id=e.id AND r.lifecycle_stage='active') AS run_count FROM experiments e";

export class ProjectService {
  constructor(
    private readonly database: Database,
    private readonly backends: () => ArtifactBackend[],
  ) {}

  async list(principal: Principal): Promise<Project[]> {
    requireScope(principal, 'read');
    // A global administrator's session sees every live Project as admin (requireProject agrees).
    return rows<Project>(
      this.database,
      `SELECT ${PROJECT_COLUMNS},CASE WHEN $2 THEN 'admin' ELSE e.role END AS role FROM projects p
      LEFT JOIN effective_project_roles e ON e.project_id=p.id AND e.user_id=$1
      WHERE p.archived_at IS NULL AND (e.role IS NOT NULL OR $2) AND ($3::uuid IS NULL OR p.id=$3)
      ORDER BY p.created_at DESC`,
      [
        principal.user.id,
        principal.method === 'session' && principal.user.isAdmin,
        principal.token?.projectId ?? null,
      ],
    );
  }

  /**
   * The creator becomes the Project admin. The members named in the request are added in the same
   * transaction, each audited like PUT /members, so a refused member leaves no Project behind.
   */
  async create(
    principal: Principal,
    input: ProjectCreateInput,
    request: RequestMetadata = NO_REQUEST_METADATA,
  ): Promise<Project> {
    const draft: AuditEventDraft = {
      ...auditActor(principal),
      ...request,
      action: 'project.create',
      resourceType: 'project',
      details: { name: input.name, visibility: input.visibility },
    };
    return recordDenial(this.database, draft, () =>
      transaction(this.database, async (connection) => {
        requireScope(principal, 'admin');
        if (principal.token?.projectId)
          throw new DomainError(
            403,
            'Project限定tokenではProjectを作成できません',
            'project_forbidden',
          );
        this.validateBackend(input.artifactBackend);
        const grants = initialMemberGrants(input.members, principal.user.id);
        assertGrantableUsers(
          grants,
          await listUserStates(
            connection,
            grants.map((grant) => grant.userId),
          ),
        );
        const project = await insertProject(connection, input);
        const projectDraft = { ...draft, resourceId: project.id, projectId: project.id };
        await connection.query(
          "INSERT INTO project_members(project_id,user_id,role) VALUES($1,$2,'admin')",
          [project.id, principal.user.id],
        );
        await this.grantInitialMembers(connection, { grants, draft: projectDraft });
        await writeAuditEvent(connection, {
          ...projectDraft,
          outcome: 'success',
          details: {
            ...draft.details,
            artifactBackend: input.artifactBackend,
            memberCount: grants.length,
          },
        });
        return { ...project, role: 'admin' };
      }),
    );
  }

  async patch(
    principal: Principal,
    change: { projectId: string; input: ProjectPatchInput },
    request: RequestMetadata = NO_REQUEST_METADATA,
  ): Promise<Project> {
    const { projectId, input } = change;
    const draft: AuditEventDraft = {
      ...auditActor(principal),
      ...request,
      action: 'project.update',
      resourceType: 'project',
      resourceId: projectId,
      projectId,
      details: { fields: Object.keys(input) },
    };
    return recordDenial(this.database, draft, () =>
      transaction(this.database, async (connection) => {
        const role = await requireProject(connection, principal, {
          projectId,
          role: 'admin',
          scope: 'admin',
        });
        if (input.artifactBackend) this.validateBackend(input.artifactBackend);
        const project = await updateProject(connection, { projectId, ...input });
        await writeAuditEvent(connection, {
          ...draft,
          outcome: 'success',
          details: {
            ...draft.details,
            ...(input.visibility ? { visibility: input.visibility } : {}),
            ...(input.artifactBackend ? { artifactBackend: input.artifactBackend } : {}),
          },
        });
        return { ...project, role };
      }),
    );
  }

  /**
   * Hides the Project from everyone and keeps its data (POST /projects/:p/archive). A global
   * administrator restores it or purges it (ProjectAdministrationService). Refused while a Job
   * waits or runs, because nothing would be left to see or stop it.
   */
  async archive(
    principal: Principal,
    projectId: string,
    request: RequestMetadata = NO_REQUEST_METADATA,
  ): Promise<void> {
    const draft: AuditEventDraft = {
      ...auditActor(principal),
      ...request,
      action: 'project.archive',
      resourceType: 'project',
      resourceId: projectId,
      projectId,
    };
    await recordDenial(this.database, draft, () =>
      transaction(this.database, async (connection) => {
        await requireProject(connection, principal, { projectId, role: 'admin', scope: 'admin' });
        // Job creation shares this row lock (shareLiveProject), so no Job appears after the check.
        const project = await lockProjectLifecycle(connection, projectId);
        // Another archive may have committed since requireProject read the Project.
        if (!project || project.archivedAt) notFound('Project');
        if (await hasActiveJobs(connection, projectId))
          throw new DomainError(
            409,
            '待機中・実行中のJobがあるProjectはアーカイブできません',
            'project_has_active_jobs',
          );
        await archiveProject(connection, { projectId, archivedBy: principal.user.id });
        await writeAuditEvent(connection, {
          ...draft,
          outcome: 'success',
          details: { name: project.name },
        });
      }),
    );
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
      `${experimentSelect} WHERE project_id=$1 AND e.lifecycle_stage='active' ORDER BY e.created_at DESC`,
      [projectId],
    );
  }

  // Deleted (MLflow soft-deleted) Experiments are hidden here as in the list.
  async experiment(
    principal: Principal,
    projectId: string,
    experimentId: string,
  ): Promise<Experiment> {
    await requireProject(this.database, principal, { projectId, role: 'viewer', scope: 'read' });
    const experiment = await first<Experiment>(
      this.database,
      `${experimentSelect} WHERE e.project_id=$1 AND e.id=$2 AND e.lifecycle_stage='active'`,
      [projectId, experimentId],
    );
    if (!experiment) notFound('Experiment');
    return experiment;
  }

  /**
   * Uses the scope that created the Experiment (runs:write). Names stay unique in the Project;
   * the lock order (Project, then Experiment) matches MLflow rename and Artifact PUT.
   */
  async updateExperiment(
    principal: Principal,
    change: { projectId: string; experimentId: string; input: ExperimentPatch },
    request: RequestMetadata = NO_REQUEST_METADATA,
  ): Promise<Experiment> {
    const { projectId, experimentId, input } = change;
    const draft: AuditEventDraft = {
      ...auditActor(principal),
      ...request,
      action: 'experiment.update',
      resourceType: 'experiment',
      resourceId: experimentId,
      projectId,
      details: { fields: Object.keys(input), ...(input.name ? { name: input.name } : {}) },
    };
    return recordDenial(this.database, draft, () =>
      transaction(this.database, async (connection) => {
        await requireProject(connection, principal, {
          projectId,
          role: 'editor',
          scope: 'runs:write',
        });
        await connection.query('SELECT id FROM projects WHERE id=$1 FOR UPDATE', [projectId]);
        const current = await first<{ name: string; lifecycleStage: string }>(
          connection,
          'SELECT name,lifecycle_stage FROM experiments WHERE project_id=$1 AND id=$2 FOR UPDATE',
          [projectId, experimentId],
        );
        if (!current) notFound('Experiment');
        if (current.lifecycleStage !== 'active') conflict('削除済みExperimentは変更できません');
        if (input.name !== undefined && input.name !== current.name) {
          const duplicate = await first(
            connection,
            'SELECT id FROM experiments WHERE project_id=$1 AND name=$2 AND id<>$3',
            [projectId, input.name, experimentId],
          );
          if (duplicate)
            throw new DomainError(409, '同名Experimentが既に存在します', 'resource_already_exists');
        }
        await connection.query(
          'UPDATE experiments SET name=COALESCE($2,name),description=COALESCE($3,description),updated_at=now() WHERE id=$1',
          [experimentId, input.name ?? null, input.description ?? null],
        );
        await writeAuditEvent(connection, {
          ...draft,
          outcome: 'success',
          details: {
            ...draft.details,
            ...(input.name !== undefined ? { previousName: current.name } : {}),
          },
        });
        return (await first<Experiment>(connection, `${experimentSelect} WHERE e.id=$1`, [
          experimentId,
        ]))!;
      }),
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

  // Each grant is audited as PUT /projects/:p/members/:userId audits it.
  private async grantInitialMembers(
    connection: Connection,
    creation: { grants: readonly ProjectMemberGrant[]; draft: AuditEventDraft },
  ): Promise<void> {
    const { draft } = creation;
    for (const { userId, role } of creation.grants) {
      await connection.query(
        'INSERT INTO project_members(project_id,user_id,role) VALUES($1,$2,$3)',
        [draft.projectId, userId, role],
      );
      await writeAuditEvent(connection, {
        ...draft,
        action: 'project.member.set',
        resourceType: 'project_member',
        resourceId: userId,
        outcome: 'success',
        details: { userId, previousRole: null, role },
      });
    }
  }

  private validateBackend(backend: ArtifactBackend): void {
    if (!this.backends().includes(backend))
      throw new DomainError(422, 'Artifact保存先が設定されていません', 'backend_unavailable');
  }
}
