import { RUN_GROUP_NONE } from '@mmt/contracts';

/** The grouping value of one Run: a tag or param value, or its Experiment ID and name. */
export interface RunGroupValue {
  runId: string;
  value: string | null;
  /** Shown instead of the value, such as the Experiment name; the value itself when absent. */
  label?: string | null;
}
export interface RunGroupAssignment {
  groupKey: string;
  label: string;
  runIds: string[];
}

const labelCollator = new Intl.Collator(undefined, { numeric: true });

// Param values such as learning rates are decimals, which a numeric collator orders digit-wise.
function asNumber(label: string): number | null {
  const number = label.trim() === '' ? NaN : Number(label);
  return Number.isFinite(number) ? number : null;
}

function compareLabels(left: string, right: string): number {
  const leftNumber = asNumber(left);
  const rightNumber = asNumber(right);
  if (leftNumber !== null && rightNumber !== null && leftNumber !== rightNumber)
    return leftNumber - rightNumber;
  return labelCollator.compare(left, right);
}

/**
 * Groups Runs in request order. Groups are sorted by label, numbers by value (lr 0.001, 0.01,
 * 0.1), and Runs without a value form the last group, `(none)`. A value that is literally
 * `(none)` joins that group, so groupKey stays unique.
 */
export function groupRuns(values: RunGroupValue[]): RunGroupAssignment[] {
  const groups = new Map<string, RunGroupAssignment>();
  let none: RunGroupAssignment | null = null;
  for (const run of values) {
    if (run.value === null || run.value === RUN_GROUP_NONE) {
      none ??= { groupKey: RUN_GROUP_NONE, label: RUN_GROUP_NONE, runIds: [] };
      none.runIds.push(run.runId);
      continue;
    }
    let group = groups.get(run.value);
    if (!group) {
      group = { groupKey: run.value, label: run.label ?? run.value, runIds: [] };
      groups.set(run.value, group);
    }
    group.runIds.push(run.runId);
  }
  const sorted = [...groups.values()].sort(
    (left, right) =>
      compareLabels(left.label, right.label) || compareLabels(left.groupKey, right.groupKey),
  );
  return none ? [...sorted, none] : sorted;
}
