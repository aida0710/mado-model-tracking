import { ChevronLeft, ChevronRight } from 'lucide-react';
import { stepIndexAfterKey } from '../../lib/mediaSteps';
import { text, textTemplates } from '../../i18n/catalog';

/**
 * Moves through the recorded steps of one media key. The range input runs over step positions,
 * not step values, so every stop is a step that has media.
 */
export function MediaStepSlider({
  steps,
  step,
  onStepChange,
}: {
  /** Recorded steps in ascending order. */
  steps: readonly number[];
  step: number;
  onStepChange: (step: number) => void;
}) {
  const index = Math.max(0, steps.indexOf(step));
  const moveTo = (nextIndex: number) => {
    const next = steps[nextIndex];
    if (next !== undefined && next !== step) onStepChange(next);
  };
  const position = textTemplates.mediaStepPosition(step, index + 1, steps.length);
  return (
    <div className="media-step-slider">
      <button
        type="button"
        className="button small"
        onClick={() => moveTo(index - 1)}
        disabled={index === 0}
        aria-label={text.mediaPreviousStep}
      >
        <ChevronLeft size={14} />
      </button>
      <input
        type="range"
        min={0}
        max={Math.max(0, steps.length - 1)}
        step={1}
        value={index}
        disabled={steps.length < 2}
        aria-label={text.mediaStepSlider}
        aria-valuetext={position}
        onChange={(event) => moveTo(Number(event.target.value))}
        onKeyDown={(event) => {
          const nextIndex = stepIndexAfterKey(steps.length, index, event.key);
          if (nextIndex === null) return;
          // The native range would move by a fraction of the range on PageUp/PageDown; keep one rule.
          event.preventDefault();
          moveTo(nextIndex);
        }}
      />
      <button
        type="button"
        className="button small"
        onClick={() => moveTo(index + 1)}
        disabled={index >= steps.length - 1}
        aria-label={text.mediaNextStep}
      >
        <ChevronRight size={14} />
      </button>
      <output className="mono media-step-value" aria-live="polite">
        {position}
      </output>
    </div>
  );
}
