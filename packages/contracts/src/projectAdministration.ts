import type { ArtifactBackend, ProjectRole, ProjectVisibility } from './index.js';

/** A user to add as a direct member when the Project is created. */
export interface ProjectMemberGrant {
  userId: string;
  role: ProjectRole;
}

/**
 * POST /projects. The creator becomes the Project admin; visibility defaults to 'public'. The
 * Project and its members are created together: an unknown or non-human user refuses the whole
 * request. A grant for the creator is ignored (the creator is always admin).
 */
export interface ProjectCreate {
  name: string;
  description?: string;
  artifactBackend?: ArtifactBackend;
  visibility?: ProjectVisibility;
  members?: ProjectMemberGrant[];
}

/** PATCH /projects/:p, by the Project admin or a global administrator. */
export interface ProjectPatch {
  description?: string;
  artifactBackend?: ArtifactBackend;
  visibility?: ProjectVisibility;
}

/**
 * A Project as the global administrator sees it (GET /admin/projects).
 * POST /projects/:p/archive hides a Project and keeps its data; POST /admin/projects/:p/restore
 * brings it back; DELETE /admin/projects/:p removes an archived Project and its data for good.
 */
export interface AdminProject {
  id: string;
  name: string;
  description: string;
  artifactBackend: ArtifactBackend;
  visibility: ProjectVisibility;
  /** Users with a direct grant or a group binding. Access through public visibility is not counted. */
  memberCount: number;
  /** Active (not MLflow-deleted) Runs. */
  runCount: number;
  createdAt: string;
  archivedAt: string | null;
}

export interface AdminProjectQuery {
  /** Archived Projects are left out unless this is true. */
  includeArchived?: boolean;
}
