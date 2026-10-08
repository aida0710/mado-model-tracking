import { Link } from 'react-router-dom';
import type { AutomatedRunSummary, ModelVersionDetail, Run } from '@mmt/contracts';
import { DetailsList } from './JsonDetails';
import { LineageGraph } from './LineageGraph';
import { StatusBadge } from './StatusBadge';
import { formatDate } from '../lib/format';
import { buildModelVersionLineage, LINEAGE_RESULT_RUN_LIMIT } from '../lib/modelVersionLineage';
import { text } from '../i18n/catalog';

/** The version's identity and where it came from, with the training → version → results band. */
export function ModelVersionSummary({
  projectId,
  detail,
  sourceRun,
  resultRuns,
}: {
  projectId: string;
  detail: ModelVersionDetail;
  sourceRun: Run | undefined;
  resultRuns: AutomatedRunSummary[];
}) {
  const { model, version, aliases } = detail;
  const base = `/projects/${projectId}`;
  const lineage = buildModelVersionLineage({
    model,
    version,
    sourceRun: sourceRun ?? null,
    resultRuns,
  });
  return (
    <section className="model-version-section" aria-label={text.modelVersionSummary}>
      <div className="model-version-summary">
        <DetailsList
          entries={[
            [
              text.modelVersionModel,
              <Link to={`${base}/models?version=${version.id}`}>{model.name}</Link>,
            ],
            [text.family, <span className="mono">{version.family}</span>],
            [
              text.modelVersionAliases,
              aliases.length ? (
                <span className="model-version-aliases">
                  {aliases.map((alias) => (
                    <span key={alias} className="model-version-alias mono">
                      {alias}
                    </span>
                  ))}
                </span>
              ) : (
                '—'
              ),
            ],
            [
              text.sourceRun,
              version.sourceRunId ? (
                <span>
                  <Link className="mono" to={`${base}/runs/${version.sourceRunId}`}>
                    {sourceRun?.name ?? version.sourceRunId}
                  </Link>{' '}
                  {sourceRun && <StatusBadge status={sourceRun.status} />}
                </span>
              ) : (
                '—'
              ),
            ],
            [
              text.parents,
              version.parentModelVersionIds.length
                ? version.parentModelVersionIds.map((id) => (
                    <Link key={id} className="version-link mono" to={`${base}/models?version=${id}`}>
                      {id}
                    </Link>
                  ))
                : '—',
            ],
            [
              text.weightsUri,
              <span className="mono break-word">{version.weightsUri ?? '—'}</span>,
            ],
            [text.artifactId, <span className="mono">{version.artifactId ?? '—'}</span>],
            [
              text.defaultCode,
              version.defaultCodeVersionId ? (
                <Link className="mono" to={`${base}/codes?version=${version.defaultCodeVersionId}`}>
                  {version.defaultCodeVersionId}
                </Link>
              ) : (
                '—'
              ),
            ],
            [text.created, formatDate(version.createdAt)],
          ]}
        />
      </div>
      <h2>{text.modelVersionLineage}</h2>
      <div className="model-version-lineage">
        <LineageGraph graph={lineage} projectId={projectId} />
      </div>
      {resultRuns.length > LINEAGE_RESULT_RUN_LIMIT && (
        <p className="muted">{text.modelVersionLineageTruncated}</p>
      )}
    </section>
  );
}
