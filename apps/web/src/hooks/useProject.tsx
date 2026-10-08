import { createContext, useContext } from 'react';
import type { Project } from '@mmt/contracts';
import { canEditProject, canManageProject } from '../lib/permissions';

export const ProjectContext = createContext<{
  project: Project;
  projects: Project[];
  reloadProjects: () => void;
} | null>(null);
export function useProject() {
  const context = useContext(ProjectContext);
  if (!context) throw new Error('Project context is required');
  return {
    ...context,
    canEdit: canEditProject(context.project.role),
    isProjectAdmin: canManageProject(context.project.role),
  };
}
