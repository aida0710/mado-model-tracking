import type { HookFilter, RunKind } from '@mmt/contracts';

/** What an event says about itself for the filter; a missing fact never matches a condition. */
export interface HookFilterSubject {
  modelFamily: string | null;
  experimentId: string | null;
  runKind: RunKind | null;
  runStatus: string | null;
  tags: Record<string, string>;
}

/** Every condition of the filter must hold; an empty filter matches every event. */
export function matchesHookFilter(filter: HookFilter, subject: HookFilterSubject): boolean {
  const within = <T>(allowed: readonly T[] | undefined, value: T | null) =>
    allowed === undefined || (value !== null && allowed.includes(value));
  return (
    within(filter.modelFamilies, subject.modelFamily) &&
    within(filter.experimentIds, subject.experimentId) &&
    within(filter.runKinds, subject.runKind) &&
    within<string>(filter.runStatuses, subject.runStatus) &&
    Object.entries(filter.tags ?? {}).every(([key, value]) => subject.tags[key] === value)
  );
}
