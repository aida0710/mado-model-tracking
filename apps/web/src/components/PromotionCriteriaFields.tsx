import { useId } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import type { PromotionCriterionDirection, PromotionCriterionMode } from '@mmt/contracts';
import {
  PROMOTION_DIRECTIONS,
  PROMOTION_MODES,
  getCriterionThresholdMeaning,
  previewCriterion,
  summarizeCriterion,
  type PromotionCriterionDraft,
} from '../lib/promotionPolicyInput';
import {
  criterionThresholdMeaningLabels,
  promotionDirectionLabels,
  promotionModeLabels,
} from '../i18n/promotion';
import { text } from '../i18n/catalog';

// Spells out the typed row, e.g. "werの基準との差 ≤ -0.01（改善が必要）", so the threshold's sign
// is read the way the API will apply it. Nothing is shown until metric and threshold are valid.
function CriterionPreview({ draft }: { draft: PromotionCriterionDraft }) {
  const parsed = previewCriterion(draft);
  if (!parsed) return null;
  const meaning = getCriterionThresholdMeaning(parsed);
  return (
    <p className="muted promotion-criterion-preview">
      <span className="mono">{summarizeCriterion(parsed)}</span>
      {meaning && `（${criterionThresholdMeaningLabels[meaning]}）`}
    </p>
  );
}

function CriterionRow({
  criterion,
  canRemove,
  onChange,
  onRemove,
}: {
  criterion: PromotionCriterionDraft;
  canRemove: boolean;
  onChange: (changes: Partial<PromotionCriterionDraft>) => void;
  onRemove: () => void;
}) {
  const id = useId();
  return (
    <div>
      <div className="promotion-criterion-row">
        <div className="field">
          <label htmlFor={`${id}-metric`}>{text.promotionCriterionMetric}</label>
          <input
            id={`${id}-metric`}
            className="mono"
            value={criterion.metric}
            required
            placeholder="wer"
            onChange={(event) => onChange({ metric: event.target.value })}
          />
        </div>
        <div className="field">
          <label htmlFor={`${id}-direction`}>{text.promotionCriterionDirection}</label>
          <select
            id={`${id}-direction`}
            value={criterion.direction}
            onChange={(event) =>
              onChange({ direction: event.target.value as PromotionCriterionDirection })
            }
          >
            {PROMOTION_DIRECTIONS.map((direction) => (
              <option key={direction} value={direction}>
                {promotionDirectionLabels[direction]}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor={`${id}-mode`}>{text.promotionCriterionMode}</label>
          <select
            id={`${id}-mode`}
            value={criterion.mode}
            onChange={(event) => onChange({ mode: event.target.value as PromotionCriterionMode })}
          >
            {PROMOTION_MODES.map((mode) => (
              <option key={mode} value={mode}>
                {promotionModeLabels[mode]}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor={`${id}-threshold`}>{text.promotionCriterionThreshold}</label>
          <input
            id={`${id}-threshold`}
            className="mono"
            inputMode="decimal"
            value={criterion.threshold}
            required
            onChange={(event) => onChange({ threshold: event.target.value })}
          />
        </div>
        <button
          type="button"
          className="icon-button field-action"
          aria-label={text.promotionRemoveCriterion}
          disabled={!canRemove}
          onClick={onRemove}
        >
          <Trash2 size={16} />
        </button>
      </div>
      <CriterionPreview draft={criterion} />
    </div>
  );
}

/** Editable list of pass/fail criteria. Every criterion must hold for a pass. */
export function PromotionCriteriaFields({
  criteria,
  onChange,
  onAdd,
  onRemove,
}: {
  criteria: PromotionCriterionDraft[];
  onChange: (key: string, changes: Partial<PromotionCriterionDraft>) => void;
  onAdd: () => void;
  onRemove: (key: string) => void;
}) {
  return (
    <fieldset className="promotion-criteria">
      <legend>{text.promotionCriteria}</legend>
      <p className="muted">{text.promotionCriteriaHint}</p>
      {criteria.map((criterion) => (
        <CriterionRow
          key={criterion.key}
          criterion={criterion}
          canRemove={criteria.length > 1}
          onChange={(changes) => onChange(criterion.key, changes)}
          onRemove={() => onRemove(criterion.key)}
        />
      ))}
      {criteria.some((criterion) => criterion.mode === 'relative_delta') && (
        <p className="muted">{text.promotionRelativeDeltaHint}</p>
      )}
      <div>
        <button type="button" className="button small" onClick={onAdd}>
          <Plus size={15} />
          {text.promotionAddCriterion}
        </button>
      </div>
    </fieldset>
  );
}
