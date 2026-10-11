import type { Project } from '@mmt/contracts';

// From this many Projects the switcher's list no longer fits without scrolling, so it offers a
// field to narrow the list by name.
export const PROJECT_FILTER_THRESHOLD = 8;

export function shouldOfferProjectFilter(projectCount: number): boolean {
  return projectCount >= PROJECT_FILTER_THRESHOLD;
}

// Full-width and half-width letters and either case match each other.
function normalizeForMatching(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase();
}

/** The Projects whose name contains every word of `query`, in their original order. */
export function filterProjects<T extends Pick<Project, 'name'>>(projects: T[], query: string): T[] {
  const words = normalizeForMatching(query).split(/\s+/).filter(Boolean);
  if (!words.length) return projects;
  return projects.filter((project) => {
    const name = normalizeForMatching(project.name);
    return words.every((word) => name.includes(word));
  });
}
