import { useState } from 'react';
import type { ModelVersionDetail, PromotionEvaluation, PromotionPolicy } from '@mmt/contracts';
import { usePromotionChoices } from '../hooks/usePromotionChoices';
import { currentDecisionsForAlias } from '../lib/promotionEvidence';
import { PromotionDialog } from '../dialogs/PromotionDialog';
import { CriterionResults, DecisionBadge } from './PromotionEvaluationTable';
import { ErrorNotice, Resource } from './Feedback';
import { text } from '../i18n/catalog';

// Notes on a pass that an autoPromote policy did not turn into an alias change.
const automaticPromotionNotes: Partial<Record<NonNullable<PromotionEvaluation['reason']>, string>> =
  {
    baseline_changed: text.promotionCheckBaselineChanged,
    promotion_denied: text.promotionCheckPromotionDenied,
  };

function latestDecision(
  decisions: PromotionEvaluation[],
  policy: PromotionPolicy,
  versionId: string,
): PromotionEvaluation | undefined {
  return currentDecisionsForAlias(decisions, {
    policies: [policy],
    alias: policy.targetAlias,
    versionId,
  })[0];
}

/**
 * Where the version stands against each promotion policy of its Model: passed, failed or still
 * waiting for an evaluation, the criteria behind it, and a button to promote by hand with that
 * decision as evidence. Shown to editors and admins only; the API decides what is allowed.
 */
export function PromotionCheckCard({
  projectId,
  detail,
  onPromoted,
}: {
  projectId: string;
  detail: ModelVersionDetail;
  onPromoted: () => void;
}) {
  const versionId = detail.version.id;
  const choices = usePromotionChoices(projectId, detail.model.id, versionId);
  const [promoting, setPromoting] = useState<{ alias: string; evaluationId?: string } | null>(null);
  return (
    <section className="model-version-section" aria-label={text.promotionCheck}>
      <h2>{text.promotionCheck}</h2>
      <ErrorNotice message={choices.decisions.error} retry={choices.decisions.reload} />
      <Resource query={choices.policies}>
        {(policies) =>
          policies.length ? (
            <ul className="promotion-check-list">
              {policies.map((policy) => {
                const decision = latestDecision(choices.decisions.value ?? [], policy, versionId);
                const isCurrent = detail.aliases.includes(policy.targetAlias);
                const note = decision?.reason
                  ? automaticPromotionNotes[decision.reason]
                  : undefined;
                return (
                  <li key={policy.id} className="promotion-check">
                    <div className="section-heading">
                      <h3>
                        {policy.name} <span className="mono">→ {policy.targetAlias}</span>
                      </h3>
                      {!isCurrent && (
                        <button
                          className="button small primary"
                          onClick={() =>
                            setPromoting({
                              alias: policy.targetAlias,
                              evaluationId:
                                decision?.decision === 'passed' ? decision.id : undefined,
                            })
                          }
                        >
                          {text.promote}
                        </button>
                      )}
                    </div>
                    {decision ? (
                      <>
                        <DecisionBadge evaluation={decision} />
                        {decision.promoted && (
                          <div className="muted">{text.promotionCheckPromotedAutomatically}</div>
                        )}
                        {note && <div className="muted">{note}</div>}
                        <CriterionResults results={decision.criteriaResults} />
                      </>
                    ) : (
                      <span className="status-badge status-queued">
                        <span aria-hidden="true">●</span>
                        {text.promotionCheckPending}
                      </span>
                    )}
                    {isCurrent && <div className="muted">{text.promotionCheckCurrentAlias}</div>}
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="muted">{text.promotionCheckEmpty}</p>
          )
        }
      </Resource>
      {promoting && (
        <PromotionDialog
          model={detail.model}
          versions={[detail.version]}
          initial={{ ...promoting, versionId }}
          onClose={() => setPromoting(null)}
          onSaved={() => {
            setPromoting(null);
            choices.reload();
            onPromoted();
          }}
        />
      )}
    </section>
  );
}
