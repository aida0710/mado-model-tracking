import { Navigate, useParams } from 'react-router-dom';
import { RefreshCw } from 'lucide-react';
import type {
  ModelAutomationExecutionPage,
  ModelAutomationRule,
  ModelVersion,
  ModelVersionDetail,
  Run,
} from '@mmt/contracts';
import type { QueryState } from '../hooks/useQuery';
import { useProject } from '../hooks/useProject';
import { useModelVersionDetail } from '../hooks/useModelVersionDetail';
import { useModelVersionEvaluations } from '../hooks/useModelVersionEvaluations';
import { useEvaluationComparison } from '../hooks/useEvaluationComparison';
import { useEvaluationBaseline, type EvaluationBaseline } from '../hooks/useEvaluationBaseline';
import { useQuery } from '../hooks/useQuery';
import { registryApi } from '../api/registry';
import { usePromotionChoices } from '../hooks/usePromotionChoices';
import { PageHeader } from '../components/PageHeader';
import { ErrorNotice, Resource } from '../components/Feedback';
import { ModelVersionSummary } from '../components/ModelVersionSummary';
import { ModelVersionAutomation } from '../components/ModelVersionAutomation';
import { EvaluationResultsTable } from '../components/EvaluationResultsTable';
import { EvaluationComparisonPanel } from '../components/EvaluationComparisonPanel';
import { PromotionEvaluationTable } from '../components/PromotionEvaluationTable';
import { PromotionCheckCard } from '../components/PromotionCheckCard';
import { CommentThread } from '../components/comments/CommentThread';
import { collectSummaryMetrics, summarizeEvaluations } from '../lib/evaluationSummary';
import { modelVersionPath } from '../lib/modelVersionPath';
import { text } from '../i18n/catalog';
import { evaluationTextTemplates } from '../i18n/evaluation';

/**
 * One model version from training to results: where it came from, what automation ran on it,
 * its evaluation metrics against the baseline version, and its promotion decisions. Editors can
 * promote it from the promotion check; everything else is read-only apart from the comments.
 */
export function ModelVersionPage() {
  const { project, canEdit } = useProject();
  const { modelId = '', versionId = '' } = useParams();
  const { detail, sourceRun, rules, executions } = useModelVersionDetail(project.id, versionId);
  // Every version of the Model: the version numbers to show and the baselines to choose from.
  const versions = useQuery(`${project.id}:model-versions:${modelId}`, (signal) =>
    registryApi.modelVersions(project.id, modelId, signal),
  );
  const baseline = useEvaluationBaseline({
    aliases: detail.value?.model.aliases ?? {},
    candidateVersionId: versionId,
    versions: versions.value ?? [],
  });
  const evaluations = useModelVersionEvaluations(project.id, detail.value, baseline.versionId);
  // Loaded here rather than in their panels so that the reload button refreshes them too: an
  // evaluation that ends after the page opened changes both the comparison and the decisions.
  const evaluationComparison = useEvaluationComparison({
    projectId: project.id,
    modelId,
    candidateVersionId: versionId,
    baseline: baseline.choice,
  });
  const promotionChoices = usePromotionChoices(project.id, modelId, versionId);
  const reloadAll = () => {
    detail.reload();
    versions.reload();
    sourceRun.reload();
    executions.reload();
    evaluations.results.reload();
    evaluations.baseline.results.reload();
    evaluations.promotionEvaluations.reload();
    evaluationComparison.comparison.reload();
    promotionChoices.reload();
  };
  // A link with the wrong Model id still names the version; send it to the right address.
  if (detail.value && detail.value.model.id !== modelId)
    return (
      <Navigate
        replace
        to={modelVersionPath(project.id, { modelId: detail.value.model.id, versionId })}
      />
    );
  return (
    <section className="page model-version-page">
      <PageHeader
        title={
          detail.value
            ? `${detail.value.model.name} / ${detail.value.version.version}`
            : text.modelVersion
        }
        eyebrow={`${project.name} · ${text.modelVersion}`}
        actions={
          <button className="icon-button" aria-label={text.refresh} onClick={reloadAll}>
            <RefreshCw size={17} />
          </button>
        }
      />
      <Resource query={detail}>
        {(value) => (
          <ModelVersionContent
            projectId={project.id}
            detail={value}
            sourceRun={sourceRun.value}
            rules={rules.value ?? []}
            versions={versions.value ?? []}
            selectedBaseline={baseline}
            executions={executions}
            evaluations={evaluations}
            evaluationComparison={evaluationComparison}
            promotionChoices={promotionChoices}
            canPromote={canEdit}
            onPromoted={reloadAll}
          />
        )}
      </Resource>
    </section>
  );
}

function ModelVersionContent({
  projectId,
  detail,
  sourceRun,
  rules,
  versions,
  selectedBaseline,
  executions,
  evaluations,
  evaluationComparison,
  promotionChoices,
  canPromote,
  onPromoted,
}: {
  projectId: string;
  detail: ModelVersionDetail;
  sourceRun: Run | undefined;
  rules: ModelAutomationRule[];
  versions: ModelVersion[];
  selectedBaseline: EvaluationBaseline;
  executions: QueryState<ModelAutomationExecutionPage>;
  evaluations: ReturnType<typeof useModelVersionEvaluations>;
  evaluationComparison: ReturnType<typeof useEvaluationComparison>;
  promotionChoices: ReturnType<typeof usePromotionChoices>;
  canPromote: boolean;
  onPromoted: () => void;
}) {
  const { results, baseline, promotionEvaluations } = evaluations;
  const resultRuns = results.value?.items ?? [];
  const evaluationRuns = resultRuns.filter((run) => run.kind === 'evaluation');
  const summary = summarizeEvaluations({
    candidateRuns: evaluationRuns,
    baselineRuns: baseline.results.value?.items ?? [],
    summaryMetrics: collectSummaryMetrics(evaluationRuns, rules),
  });
  // Versions are named by number everywhere on the page; a version not loaded yet keeps its id.
  const versionLabel = (id: string) =>
    evaluationTextTemplates.versionLabel(
      (id === detail.version.id ? detail.version : versions.find((version) => version.id === id))
        ?.version ?? id,
    );
  const baselineLabel = !selectedBaseline.choice
    ? null
    : selectedBaseline.choice.kind === 'alias'
      ? selectedBaseline.choice.alias
      : versionLabel(selectedBaseline.choice.versionId);
  return (
    <>
      <ModelVersionSummary
        projectId={projectId}
        detail={detail}
        sourceRun={sourceRun}
        resultRuns={resultRuns}
      />
      <ModelVersionAutomation projectId={projectId} executions={executions} rules={rules} />
      <section className="model-version-section" aria-label={text.evaluationResults}>
        <h2>{text.evaluationResults}</h2>
        <ErrorNotice message={baseline.results.error} retry={baseline.results.reload} />
        <Resource query={results}>
          {(page) => (
            <>
              <EvaluationResultsTable
                projectId={projectId}
                runs={evaluationRuns}
                rules={rules}
                summary={summary}
                baselineLabel={baseline.versionId ? baselineLabel : null}
              />
              {page.nextCursor && <p className="muted">{text.evaluationResultsTruncated}</p>}
            </>
          )}
        </Resource>
      </section>
      <EvaluationComparisonPanel
        projectId={projectId}
        model={detail.model}
        candidateVersionId={detail.version.id}
        versions={versions}
        versionLabel={versionLabel}
        baseline={selectedBaseline}
        evaluationComparison={evaluationComparison}
      />
      {canPromote && (
        <PromotionCheckCard
          projectId={projectId}
          detail={detail}
          versionLabel={versionLabel}
          choices={promotionChoices}
          onPromoted={onPromoted}
        />
      )}
      <section className="model-version-section" aria-label={text.versionPromotionEvaluations}>
        <h2>{text.versionPromotionEvaluations}</h2>
        <ErrorNotice message={promotionEvaluations.error} retry={promotionEvaluations.reload} />
        <PromotionEvaluationTable
          evaluations={promotionEvaluations.items}
          projectId={projectId}
          versionLabel={versionLabel}
          canReevaluate={false}
          reevaluating={false}
          onReevaluate={() => undefined}
          empty={
            promotionEvaluations.loading ? text.loading : text.versionPromotionEvaluationsEmpty
          }
        />
        {promotionEvaluations.hasMore && (
          <button
            className="button small"
            disabled={promotionEvaluations.loading}
            onClick={promotionEvaluations.loadMore}
          >
            {text.loadMore}
          </button>
        )}
      </section>
      <CommentThread
        projectId={projectId}
        targetType="model_version"
        targetId={detail.version.id}
      />
    </>
  );
}
