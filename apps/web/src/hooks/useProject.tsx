import { createContext, useContext } from 'react';
import type { Project } from '@mmt/contracts';

export const ProjectContext = createContext<{
  project: Project;
  reloadProjects: () => void;
} | null>(null);
export function useProject() {
  const context = useContext(ProjectContext);
  if (!context) throw new Error('Project context is required');
  return {
    ...context,
    canEdit: context.project.role !== 'viewer',
    isProjectAdmin: context.project.role === 'admin',
  };
}
