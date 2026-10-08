import { useId } from 'react';
import type { RunGroupBy } from '@mmt/contracts';
import { text } from '../../i18n/catalog';

type GroupingKind = RunGroupBy['kind'] | 'none';

const groupingLabels: Record<GroupingKind, string> = {
  none: text.chartGroupingNone,
  tag: text.chartGroupingTag,
  param: text.chartGroupingParam,
  experiment: text.chartGroupingExperiment,
};

/**
 * Chooses how Runs are grouped: by a tag, a param or the Experiment. `tagKeys` and `paramKeys`
 * are suggestions from the listed Runs; any key can be typed.
 */
export function RunGroupingControl({
  value,
  tagKeys,
  paramKeys,
  onChange,
}: {
  value: RunGroupBy | undefined;
  tagKeys: readonly string[];
  paramKeys: readonly string[];
  onChange: (value: RunGroupBy | undefined) => void;
}) {
  const id = useId();
  const kind: GroupingKind = value?.kind ?? 'none';
  const suggestions = kind === 'tag' ? tagKeys : kind === 'param' ? paramKeys : [];

  function changeKind(next: GroupingKind) {
    if (next === 'none') return onChange(undefined);
    if (next === 'experiment') return onChange({ kind: 'experiment' });
    const known = next === 'tag' ? tagKeys : paramKeys;
    // A tag or param grouping needs a key; start from the first one the listed Runs have.
    const key = value?.kind === next ? value.key : known[0];
    onChange(key ? { kind: next, key } : { kind: next, key: '' });
  }

  return (
    <div className="run-grouping-control">
      <label className="toolbar-select" htmlFor={`${id}-kind`}>
        <span>{text.chartGrouping}</span>
        <select
          id={`${id}-kind`}
          value={kind}
          onChange={(event) => changeKind(event.target.value as GroupingKind)}
        >
          {Object.entries(groupingLabels).map(([option, label]) => (
            <option key={option} value={option}>
              {label}
            </option>
          ))}
        </select>
      </label>
      {(kind === 'tag' || kind === 'param') && (
        <label className="toolbar-select" htmlFor={`${id}-key`}>
          <span>{text.chartGroupingKey}</span>
          <input
            id={`${id}-key`}
            list={`${id}-keys`}
            value={value?.key ?? ''}
            onChange={(event) => onChange({ kind, key: event.target.value })}
          />
          <datalist id={`${id}-keys`}>
            {suggestions.map((key) => (
              <option key={key} value={key} />
            ))}
          </datalist>
        </label>
      )}
    </div>
  );
}

/** A tag or param grouping without a key cannot be requested yet. */
export const isCompleteGrouping = (value: RunGroupBy | undefined): value is RunGroupBy =>
  value !== undefined && (value.kind === 'experiment' || Boolean(value.key?.trim()));
