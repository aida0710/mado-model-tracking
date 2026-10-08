import { Link } from 'react-router-dom';
import {
  PROMOTION_FIRST_RELEASE_REASON,
  type PromotionCriterionOutcome,
  type PromotionCriterionResult,
  type PromotionDecision,
  type PromotionEvaluation,
} from '@mmt/contracts';
import { DataTable } from './DataTable';
import { formatDate } from '../lib/format';
import { summarizeCriterion } from '../lib/promotionPolicyInput';
import {
  formatDelta,
  formatMetricValue,
  formatRelativeDelta,
} from '../lib/evaluationComparisonDisplay';
import { promotionDecisionLabels, promotionTextTemplates } from '../i18n/promotion';
import { text } from '../i18n/catalog';

// Decisions reuse the Run status colors: passed reads as finished, failed as failed.
const decisionBadgeClass: Record<PromotionDecision, string> = {
  passed: 'status-finished',
  failed: 'status-failed',
  insufficient: 'status-queued',
  skipped: 'status-canceled',
};

export function DecisionBadge({ evaluation }: { evaluation: PromotionEvaluation }) {
  return (
    <>
      <span className={`status-badge ${decisionBadgeClass[evaluation.decision]}`}>
        <span aria-hidden="true">●</span>
        {promotionDecisionLabels[evaluation.decision]}
      </span>
      {evaluation.reason === PROMOTION_FIRST_RELEASE_REASON && (
        <div className="muted">{text.promotionFirstRelease}</div>
      )}
      {evaluation.sequence > 1 && (
        <div className="muted">
          {promotionTextTemplates.reevaluationSequence(evaluation.sequence)}
        </div>
      )}
    </>
  );
}

const criterionOutcomeClass: Record<PromotionCriterionOutcome, string> = {
  passed: 'promotion-criterion-passed',
  failed: 'promotion-criterion-failed',
  insufficient: 'promotion-criterion-failed',
};
const criterionOutcomeLabel: Record<PromotionCriterionOutcome, string> = {
  passed: text.promotionCriterionPassed,
  failed: text.promotionCriterionFailed,
  insufficient: text.promotionCriterionInsufficient,
};

function formatComparedValue(result: PromotionCriterionResult): string {
  if (result.mode === 'relative_delta') return formatRelativeDelta(result.observed);
  if (result.mode === 'delta') return formatDelta(result.observed);
  return formatMetricValue(result.observed, result.candidateStatus, {
    notFinite: text.metricNotFinite,
  });
}

export function CriterionResults({ results }: { results: PromotionCriterionResult[] }) {
  return (
    <ul className="promotion-criterion-results">
      {results.map((result, index) => (
        <li key={`${result.metric}-${index}`}>
          <span className={criterionOutcomeClass[result.outcome]}>
            {criterionOutcomeLabel[result.outcome]}
          </span>{' '}
          <span className="mono">{summarizeCriterion(result)}</span>
          {' : '}
          <span className="mono">{formatComparedValue(result)}</span>
          {result.mode !== 'absolute' && (
            <span className="muted">
              {' '}
              ({text.metricCandidate}{' '}
              {formatMetricValue(result.candidate, result.candidateStatus, {
                notFinite: text.metricNotFinite,
              })}
              {' / '}
              {text.metricBaseline}{' '}
              {formatMetricValue(result.baseline, result.baselineStatus, {
                notFinite: text.metricNotFinite,
              })}
              )
            </span>
          )}
          {result.reason && <span className="muted mono"> {result.reason}</span>}
        </li>
      ))}
    </ul>
  );
}

function VersionLink({
  projectId,
  versionId,
  versionLabel,
}: {
  projectId: string;
  versionId: string | null;
  versionLabel: (id: string) => string;
}) {
  if (!versionId) return <>—</>;
  return (
    <Link className="mono" to={`/projects/${projectId}/models?version=${versionId}`}>
      {versionLabel(versionId)}
    </Link>
  );
}

// Full Run ids are 36 characters; the prefix keeps the history table readable and the title has all.
const RUN_ID_PREFIX_LENGTH = 8;

function RunLink({
  projectId,
  runId,
  label,
}: {
  projectId: string;
  runId: string | null;
  label: string;
}) {
  return (
    <div>
      <span className="muted">{label} </span>
      {runId ? (
        <Link className="mono" title={runId} to={`/projects/${projectId}/runs/${runId}`}>
          {runId.slice(0, RUN_ID_PREFIX_LENGTH)}
        </Link>
      ) : (
        '—'
      )}
    </div>
  );
}

/** Append-only decisions of one promotion policy, newest first. */
export function PromotionEvaluationTable({
  evaluations,
  projectId,
  versionLabel,
  canReevaluate,
  reevaluating,
  onReevaluate,
  empty,
}: {
  evaluations: PromotionEvaluation[];
  projectId: string;
  versionLabel: (versionId: string) => string;
  canReevaluate: boolean;
  reevaluating: boolean;
  onReevaluate: (evaluationId: string) => void;
  empty: string;
}) {
  return (
    <DataTable
      items={evaluations}
      rowKey={(evaluation) => evaluation.id}
      empty={empty}
      columns={[
        {
          key: 'createdAt',
          label: text.promotionEvaluatedAt,
          render: (evaluation) => formatDate(evaluation.createdAt),
        },
        {
          key: 'decision',
          label: text.promotionDecision,
          render: (evaluation) => <DecisionBadge evaluation={evaluation} />,
        },
        {
          key: 'candidate',
          label: text.promotionCandidateVersion,
          render: (evaluation) => (
            <VersionLink
              projectId={projectId}
              versionId={evaluation.candidateVersionId}
              versionLabel={versionLabel}
            />
          ),
        },
        {
          key: 'baseline',
          label: text.baselineVersion,
          render: (evaluation) => (
            <VersionLink
              projectId={projectId}
              versionId={evaluation.baselineVersionId}
              versionLabel={versionLabel}
            />
          ),
        },
        {
          key: 'runs',
          label: text.promotionEvaluationRuns,
          render: (evaluation) => (
            <>
              <RunLink
                projectId={projectId}
                runId={evaluation.candidateRunId}
                label={text.metricCandidate}
              />
              <RunLink
                projectId={projectId}
                runId={evaluation.baselineRunId}
                label={text.metricBaseline}
              />
            </>
          ),
        },
        {
          key: 'criteria',
          label: text.promotionCriterionResults,
          render: (evaluation) => <CriterionResults results={evaluation.criteriaResults} />,
        },
        ...(canReevaluate
          ? [
              {
                key: 'actions',
                label: text.details,
                render: (evaluation: PromotionEvaluation) => (
                  <button
                    className="button small"
                    disabled={reevaluating}
                    onClick={() => onReevaluate(evaluation.id)}
                  >
                    {text.promotionReevaluate}
                  </button>
                ),
              },
            ]
          : []),
      ]}
    />
  );
}
