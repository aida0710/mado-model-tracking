import { useState, type FormEvent } from 'react';
import { MEDIA_COMPARE_MAX_RUNS, MEDIA_COMPARE_MAX_STEPS } from '@mmt/contracts';
import { useMediaCompare } from '../../hooks/useMediaCompare';
import { evenlySpacedSteps, parseStepList } from '../../lib/mediaSteps';
import { Empty, ErrorNotice, Resource } from '../Feedback';
import { MediaCompareGrid } from './MediaCompareGrid';
import { mediaKindLabels } from '../../i18n/media';
import { text, textTemplates } from '../../i18n/catalog';
import type { MediaCompareProps } from '../charts/chartProps';

// Columns for the "evenly spaced" shortcut: enough to follow training, few enough to fit a screen.
const EVENLY_SPACED_COLUMNS = 8;

/**
 * The Compare page's media tab: one key across the compared Runs, as a Run × step grid. Without
 * typed steps each Run shows its latest step; typed steps are shown as asked, empty where absent.
 */
export function MediaCompare({ projectId, runIds }: MediaCompareProps) {
  const [chosenKey, setChosenKey] = useState<string | null>(null);
  const [stepsInput, setStepsInput] = useState('');
  const [steps, setSteps] = useState<number[]>([]);
  const [stepsError, setStepsError] = useState<string | null>(null);
  const comparedRunIds = runIds.slice(0, MEDIA_COMPARE_MAX_RUNS);
  const { choices, selectedKey, recordedSteps, grid } = useMediaCompare({
    projectId,
    runIds: comparedRunIds,
    chosenKey,
    steps,
  });

  const applySteps = (input: string) => {
    setStepsInput(input);
    const parsed = parseStepList(input);
    if (!parsed.ok) {
      setStepsError(
        parsed.error === 'too_many' ? textTemplates.mediaCompareTooManySteps(MEDIA_COMPARE_MAX_STEPS) : text.mediaCompareStepsInvalid,
      );
      return;
    }
    setStepsError(null);
    setSteps(parsed.steps);
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    applySteps(stepsInput);
  };

  return (
    <Resource query={choices}>
      {({ runs, keys }) => {
        if (keys.length === 0 || selectedKey === null) return <Empty>{text.mediaCompareNoKeys}</Empty>;
        const runLabels = Object.fromEntries(runs.map((run) => [run.id, run.name]));
        const recorded = recordedSteps.value ?? [];
        return (
          <div className="media-compare">
            {runIds.length > MEDIA_COMPARE_MAX_RUNS && (
              <p className="notice">{textTemplates.mediaCompareTooManyRuns(MEDIA_COMPARE_MAX_RUNS)}</p>
            )}
            <form className="media-compare-toolbar" onSubmit={submit}>
              <label className="audio-viewer-select">
                {text.mediaCompareKey}
                <select
                  value={selectedKey}
                  onChange={(event) => {
                    setChosenKey(event.target.value);
                    applySteps('');
                  }}
                >
                  {keys.map((summary) => (
                    <option key={summary.key} value={summary.key}>
                      {summary.key}（{mediaKindLabels[summary.kind]}）
                    </option>
                  ))}
                </select>
              </label>
              <label className="media-compare-steps">
                {text.mediaCompareSteps}
                <input
                  value={stepsInput}
                  placeholder={text.mediaCompareStepsPlaceholder}
                  onChange={(event) => setStepsInput(event.target.value)}
                />
              </label>
              <button type="submit" className="button small">
                {text.mediaCompareApply}
              </button>
              <button type="button" className="button small" onClick={() => applySteps('')} disabled={steps.length === 0}>
                {text.mediaCompareLatest}
              </button>
              <button
                type="button"
                className="button small"
                onClick={() => applySteps(evenlySpacedSteps(recorded, EVENLY_SPACED_COLUMNS).join(', '))}
                disabled={recorded.length === 0}
              >
                {textTemplates.mediaCompareEvenly(Math.min(EVENLY_SPACED_COLUMNS, recorded.length))}
              </button>
            </form>
            {recorded.length > 0 && (
              <p className="muted media-hint">
                {textTemplates.mediaCompareRecordedSteps(recorded.length, recorded[0]!, recorded.at(-1)!)}
              </p>
            )}
            <ErrorNotice message={stepsError} />
            <Resource query={grid}>
              {(data) => (
                <MediaCompareGrid
                  key={`${data.key}:${data.steps?.join(',') ?? 'latest'}`}
                  projectId={projectId}
                  grid={data}
                  runLabels={runLabels}
                />
              )}
            </Resource>
          </div>
        );
      }}
    </Resource>
  );
}
