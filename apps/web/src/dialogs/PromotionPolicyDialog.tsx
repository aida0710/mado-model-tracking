import { useId, type ReactNode } from 'react';
import type {
  Model,
  ModelAutomationRule,
  PromotionMissingBaseline,
  PromotionPolicy,
} from '@mmt/contracts';
import type { ExecutionCatalog } from '../types/executionCatalog';
import { usePromotionPolicyForm } from '../hooks/usePromotionPolicyForm';
import { useProject } from '../hooks/useProject';
import { Dialog } from '../components/Dialog';
import { ErrorNotice } from '../components/Feedback';
import { DetailsList } from '../components/JsonDetails';
import { PromotionCriteriaFields } from '../components/PromotionCriteriaFields';
import { buildCatalogOptions, withEmptyOption } from '../lib/catalogOptions';
import {
  PROMOTION_MISSING_BASELINE_CHOICES,
  isEvaluationRuleEligible,
} from '../lib/promotionPolicyInput';
import { promotionMissingBaselineLabels, promotionTextTemplates } from '../i18n/promotion';
import { text } from '../i18n/catalog';

function Field({
  label,
  required = false,
  children,
}: {
  label: string;
  required?: boolean;
  children: (id: string) => ReactNode;
}) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>
        {label}
        {required && (
          <span className="required" aria-hidden="true">
            {' '}
            *
          </span>
        )}
      </label>
      {children(id)}
    </div>
  );
}

// The rule's fixed inputs and code version are the evaluation conditions; they are shown, not edited.
function EvaluationConditions({
  rule,
  catalog,
}: {
  rule: ModelAutomationRule;
  catalog: ExecutionCatalog;
}) {
  const options = buildCatalogOptions(catalog);
  const labelOf = (items: { value: string; label: string }[], id: string) =>
    items.find((item) => item.value === id)?.label ?? id;
  return (
    <>
      <h3>{text.promotionEvaluationConditions}</h3>
      <DetailsList
        entries={[
          [
            text.referenceDatasets,
            rule.inputDatasetVersionIds.length
              ? rule.inputDatasetVersionIds.map((id) => (
                  <div className="mono" key={id}>
                    {labelOf(options.datasets, id)}
                  </div>
                ))
              : text.noReferenceDatasets,
          ],
          [
            text.evaluationCodeVersion,
            <span className="mono">{labelOf(options.codes, rule.codeVersionId)}</span>,
          ],
        ]}
      />
    </>
  );
}

export function PromotionPolicyDialog({
  models,
  rules,
  catalog,
  initialModelId,
  onClose,
  onSaved,
}: {
  models: Model[];
  rules: ModelAutomationRule[];
  catalog: ExecutionCatalog;
  initialModelId: string;
  onClose: () => void;
  onSaved: (policy: PromotionPolicy) => void;
}) {
  const { project } = useProject();
  const form = usePromotionPolicyForm({ projectId: project.id, models, rules, initialModelId });
  const { draft } = form;
  const model = models.find((item) => item.id === draft.modelId);
  const eligibleRules = model ? rules.filter((rule) => isEvaluationRuleEligible(rule, model)) : [];
  const selectedRule = eligibleRules.find((rule) => rule.id === draft.evaluationRuleId);
  const codeOptions = buildCatalogOptions(catalog).codes;
  return (
    <Dialog fullScreenOnNarrow title={text.newPromotionPolicy} onClose={onClose} busy={form.pending} wide>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void form.save().then((policy) => {
            if (policy) onSaved(policy);
          });
        }}
      >
        <fieldset disabled={form.pending}>
          <Field label={text.name} required>
            {(id) => (
              <input
                id={id}
                value={draft.name}
                required
                onChange={(event) => form.changeDraft({ name: event.target.value })}
              />
            )}
          </Field>
          <Field label={text.promotionModel} required>
            {(id) => (
              <select
                id={id}
                value={draft.modelId}
                required
                onChange={(event) => form.changeDraft({ modelId: event.target.value })}
              >
                {withEmptyOption(
                  models.map((item) => ({
                    value: item.id,
                    label: `${item.name} · ${item.family}`,
                  })),
                ).map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label={text.promotionTargetAlias} required>
            {(id) => (
              <input
                id={id}
                className="mono"
                value={draft.targetAlias}
                required
                onChange={(event) => form.changeDraft({ targetAlias: event.target.value })}
              />
            )}
          </Field>
          <Field label={text.baselineAlias} required>
            {(id) => (
              <input
                id={id}
                className="mono"
                value={draft.baselineAlias}
                required
                onChange={(event) => form.changeDraft({ baselineAlias: event.target.value })}
              />
            )}
          </Field>
          <Field label={text.evaluationRule} required>
            {(id) => (
              <select
                id={id}
                value={draft.evaluationRuleId}
                required
                onChange={(event) => form.changeDraft({ evaluationRuleId: event.target.value })}
              >
                {withEmptyOption(
                  eligibleRules.map((rule) => ({
                    value: rule.id,
                    label: promotionTextTemplates.ruleOption(
                      rule.name,
                      codeOptions.find((option) => option.value === rule.codeVersionId)?.label ??
                        rule.codeVersionId,
                    ),
                  })),
                ).map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <p className="muted">
            {model && !eligibleRules.length
              ? text.promotionEvaluationRulesEmpty
              : text.promotionEvaluationRuleHint}
          </p>
          {selectedRule && <EvaluationConditions rule={selectedRule} catalog={catalog} />}
          <PromotionCriteriaFields
            criteria={draft.criteria}
            onChange={form.changeCriterion}
            onAdd={form.addCriterion}
            onRemove={form.removeCriterion}
          />
          <Field label={text.promotionMissingBaseline}>
            {(id) => (
              <select
                id={id}
                value={draft.missingBaseline}
                onChange={(event) =>
                  form.changeDraft({
                    missingBaseline: event.target.value as PromotionMissingBaseline,
                  })
                }
              >
                {PROMOTION_MISSING_BASELINE_CHOICES.map((choice) => (
                  <option key={choice} value={choice}>
                    {promotionMissingBaselineLabels[choice]}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <label className="checkbox-field">
            <input
              type="checkbox"
              checked={draft.autoPromote}
              onChange={(event) => form.changeDraft({ autoPromote: event.target.checked })}
            />
            {text.promotionAutoPromote}
          </label>
          <label className="checkbox-field">
            <input
              type="checkbox"
              checked={draft.enabled}
              onChange={(event) => form.changeDraft({ enabled: event.target.checked })}
            />
            {text.promotionPolicyEnabled}
          </label>
          <p className="muted">{text.promotionPolicyFixedSettings}</p>
        </fieldset>
        <ErrorNotice message={form.error} />
        <footer>
          <button type="button" className="button" disabled={form.pending} onClick={onClose}>
            {text.cancel}
          </button>
          <button className="button primary" disabled={form.pending}>
            {form.pending ? text.loading : text.create}
          </button>
        </footer>
      </form>
    </Dialog>
  );
}
