import { RUN_NOTE_TAG, type Run } from '@mmt/contracts';
import { getRunParameters } from './runParameters';
import { isSystemMetricKey } from './systemMetricKeys';

/**
 * What the charts of several Runs can offer: their metrics (system metrics have their own tab)
 * and the tags and params to group by. The Run description tag is long Markdown, never a group.
 */
export function getRunChartKeys(runs: readonly Run[]) {
  const collect = (keysOf: (run: Run) => string[]) =>
    [...new Set(runs.flatMap(keysOf))].sort((left, right) => left.localeCompare(right));
  return {
    metricKeys: collect((run) => Object.keys(run.latestMetrics).filter((key) => !isSystemMetricKey(key))),
    tagKeys: collect((run) => Object.keys(run.tags).filter((key) => key !== RUN_NOTE_TAG)),
    paramKeys: collect((run) => Object.keys(getRunParameters(run))),
  };
}
