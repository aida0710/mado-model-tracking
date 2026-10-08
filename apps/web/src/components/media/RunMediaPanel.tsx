import { useMemo } from 'react';
import type { RunMediaKeySummary } from '@mmt/contracts';
import { useMediaLocation } from '../../hooks/useMediaLocation';
import { useRunMedia } from '../../hooks/useRunMedia';
import { groupMediaByStep, nearestStep } from '../../lib/mediaSteps';
import { DataTable } from '../DataTable';
import { Empty, Resource } from '../Feedback';
import { MediaGallery } from './MediaGallery';
import { MediaStepSlider } from './MediaStepSlider';
import { mediaKindLabels } from '../../i18n/media';
import { text, textTemplates } from '../../i18n/catalog';
import type { RunMediaPanelProps } from '../charts/chartProps';

function KeyList({
  keys,
  selectedKey,
  onSelect,
}: {
  keys: RunMediaKeySummary[];
  selectedKey: string;
  onSelect: (key: string) => void;
}) {
  return (
    <DataTable
      items={keys}
      rowKey={(summary) => summary.key}
      selectedKey={selectedKey}
      columns={[
        {
          key: 'key',
          label: text.mediaKey,
          render: (summary) => (
            <button type="button" className="link-button" onClick={() => onSelect(summary.key)}>
              {summary.key}
            </button>
          ),
        },
        { key: 'kind', label: text.mediaKind, render: (summary) => mediaKindLabels[summary.kind] },
        {
          key: 'steps',
          label: text.mediaStepRange,
          className: 'mono',
          render: (summary) => textTemplates.mediaStepRangeValue(summary.minStep, summary.maxStep),
        },
        { key: 'count', label: text.mediaCount, className: 'mono', render: (summary) => textTemplates.mediaItemCount(summary.count) },
      ]}
    />
  );
}

/**
 * The Run's media tab: choose a key, then move through its recorded steps with the slider. The
 * step is kept when switching keys, snapped to the nearest step the new key recorded. The key and
 * step stay in the URL, so a link or a reload opens the same media.
 */
export function RunMediaPanel({ projectId, runId }: RunMediaPanelProps) {
  const { chosenKey, requestedStep, setKey, setStep } = useMediaLocation();
  const { keys: keysQuery, selectedKey, items } = useRunMedia({ projectId, runId, chosenKey });
  const groups = useMemo(() => (items.value ? groupMediaByStep(items.value.items) : null), [items.value]);
  const steps = useMemo(() => (groups ? [...groups.keys()] : []), [groups]);
  // The latest step by default: the most recent media is usually what one opens the tab for.
  const step = requestedStep === null ? (steps.at(-1) ?? null) : nearestStep(steps, requestedStep);

  return (
    <Resource query={keysQuery}>
      {(keys) =>
        keys.length === 0 || selectedKey === null ? (
          <Empty>{text.mediaNoKeys}</Empty>
        ) : (
          <div className="run-media-panel">
            <section aria-label={text.mediaKeys}>
              <KeyList keys={keys} selectedKey={selectedKey} onSelect={setKey} />
            </section>
            <section className="run-media-step" aria-label={selectedKey}>
              <h3>{selectedKey}</h3>
              <Resource query={items}>
                {(list) =>
                  step === null ? (
                    <Empty />
                  ) : (
                    <>
                      <MediaStepSlider steps={steps} step={step} onStepChange={setStep} />
                      <p className="muted media-hint">{text.mediaStepHint}</p>
                      {list.truncated && <p className="notice">{text.mediaTruncated}</p>}
                      {/* Keyed by step so the previous step's players unmount (and stop) on every move. */}
                      <MediaGallery key={`${selectedKey}:${step}`} projectId={projectId} items={groups!.get(step) ?? []} />
                    </>
                  )
                }
              </Resource>
            </section>
          </div>
        )
      }
    </Resource>
  );
}
