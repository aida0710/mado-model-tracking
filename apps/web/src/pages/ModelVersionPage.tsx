import { Navigate, useParams } from 'react-router-dom';
import { RefreshCw } from 'lucide-react';
import type {
  ModelAutomationExecutionPage,
  ModelAutomationRule,
  ModelVersionDetail,
  Run,
} from '@mmt/contracts';
import type { QueryState } from '../hooks/useQuery';
import { useProject } from '../hooks/useProject';
import { useModelVersionDetail } from '../hooks/useModelVersionDetail';
import { useModelVersionEvaluations } from '../hooks/useModelVersionEvaluations';
import { PageHeader } from '../components/PageHeader';
import { ErrorNotice, Resource } from '../components/Feedback';
import { ModelVersionSummary } from '../components/ModelVersionSummary';
import { ModelVersionAutomation } from '../components/ModelVersionAutomation';
import { EvaluationResultsTable } from '../components/EvaluationResultsTable';
import { EvaluationComparisonPanel } from '../components/EvaluationComparisonPanel';
import { PromotionEvaluationTable } from '../components/PromotionEvaluationTable';
import { collectSummaryMetrics, summarizeEvaluations } from '../lib/evaluationSummary';
import { modelVersionPath } from '../lib/modelVersionPath';
import { text } from '../i18n/catalog';

/**
 * One model version from training to results: where it came from, what automation ran on it,
 * its evaluation metrics against the baseline version, and its promotion decisions. Read-only.
 */
export function ModelVersionPage() {
  const { project } = useProject();
  const { modelId = '', versionId = '' } = useParams();
  const { detail, sourceRun, rules, executions } = useModelVersionDetail(project.id, versionId);
  const evaluations = useModelVersionEvaluations(project.id, detail.value);
  const reloadAll = () => {
    detail.reload();
    sourceRun.reload();
    executions.reload();
    evaluations.results.reload();
    evaluations.baseline.results.reload();
    evaluations.promotionEvaluations.reload();
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
            executions={executions}
            evaluations={evaluations}
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
  executions,
  evaluations,
}: {
  projectId: string;
  detail: ModelVersionDetail;
  sourceRun: Run | undefined;
  rules: ModelAutomationRule[];
  executions: QueryState<ModelAutomationExecutionPage>;
  evaluations: ReturnType<typeof useModelVersionEvaluations>;
}) {
  const { results, baseline, promotionEvaluations } = evaluations;
  const resultRuns = results.value?.items ?? [];
  const evaluationRuns = resultRuns.filter((run) => run.kind === 'evaluation');
  const summary = summarizeEvaluations({
    candidateRuns: evaluationRuns,
    baselineRuns: baseline.results.value?.items ?? [],
    summaryMetrics: collectSummaryMetrics(evaluationRuns, rules),
  });
  const versionLabel = (id: string) => (id === detail.version.id ? detail.version.version : id);
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
                baselineAlias={baseline.versionId ? baseline.alias : null}
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
      />
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
    </>
  );
}
