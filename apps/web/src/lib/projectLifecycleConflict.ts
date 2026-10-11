import { RequestError } from '../api/http';
import { text } from '../i18n/catalog';

// The 409 codes of archiving and purging a Project, shown as what to do next instead of the
// server text.
const conflictText: Record<string, string> = {
  project_has_active_jobs: text.projectHasActiveJobs,
  project_not_archived: text.projectNotArchived,
};

/** Runs an archive or purge request and explains its known conflicts in the screen's words. */
export async function explainProjectLifecycleConflict<T>(change: Promise<T>): Promise<T> {
  try {
    return await change;
  } catch (failure) {
    const known =
      failure instanceof RequestError && failure.status === 409 && failure.code
        ? conflictText[failure.code]
        : undefined;
    if (known) throw new Error(known);
    throw failure;
  }
}
