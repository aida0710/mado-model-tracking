import type { Run } from '@mmt/contracts';

/** Who created a Run, by name; the id only while an older API omits the name. */
export const runCreatorName = (run: Pick<Run, 'createdBy' | 'createdByName'>) =>
  run.createdByName ?? run.createdBy;
