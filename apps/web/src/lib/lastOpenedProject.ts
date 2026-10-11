import type { Project } from '@mmt/contracts';

// The Project opened last in this browser, so "/" (the app name, or leaving 全体設定) opens it
// again instead of the newest Project. This app's keys start with "mmt.".
const LAST_PROJECT_STORAGE_KEY = 'mmt.lastProject';

export function readLastProjectId(): string | null {
  try {
    return localStorage.getItem(LAST_PROJECT_STORAGE_KEY);
  } catch {
    // Storage may be blocked; "/" then opens the first Project.
    return null;
  }
}

export function rememberLastProjectId(projectId: string): void {
  try {
    localStorage.setItem(LAST_PROJECT_STORAGE_KEY, projectId);
  } catch {
    /* Remembering is a convenience; the app works without it. */
  }
}

/** The Project "/" opens: the one opened last while the user can still open it, else the first. */
export function projectToOpen(projects: Project[], lastProjectId: string | null): Project | undefined {
  return projects.find((project) => project.id === lastProjectId) ?? projects[0];
}
