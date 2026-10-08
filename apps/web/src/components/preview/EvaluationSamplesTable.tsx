import { Fragment, useMemo, useState } from 'react';
import type { Artifact } from '@mmt/contracts';
import { AudioLines } from 'lucide-react';
import { trackingApi } from '../../api/tracking';
import { useQuery } from '../../hooks/useQuery';
import {
  paginate,
  resolveArtifactReference,
  sortEvaluationSamples,
  type ArtifactReferenceError,
  type ArtifactReferenceResult,
  type EvaluationSampleOrder,
  type EvaluationSampleTable,
} from '../../lib/evaluationSamples';
import { diffCharacters, type TextDiffSegment } from '../../lib/textDiff';
import { formatValue } from '../../lib/format';
import { ErrorNotice } from '../Feedback';
import { text } from '../../i18n/catalog';
import {
  artifactReferenceErrorLabels,
  artifactsTextTemplates,
  evaluationSampleErrorLabels,
} from '../../i18n/artifacts';
import { AudioArtifactViewer } from './AudioArtifactViewer';

// Only the first errors are listed; the count still covers every broken row.
const LISTED_ERROR_LIMIT = 20;

type RunArtifactIndex = Map<string, Map<string, Artifact> | 'unavailable'>;

/** Artifacts of the Runs referenced on the current page, keyed by Run and then by path. */
function useRunArtifactIndex(projectId: string, runIds: string[]) {
  const key = runIds.length ? `${projectId}:evaluation-audio:${runIds.join(',')}` : null;
  return useQuery(key, async (signal) => {
    const entries = await Promise.all(
      runIds.map(async (runId): Promise<[string, Map<string, Artifact> | 'unavailable']> => {
        try {
          const artifacts = await trackingApi.artifacts(projectId, runId, signal);
          return [runId, new Map(artifacts.map((artifact) => [artifact.path, artifact]))];
        } catch (error) {
          if (signal.aborted) throw error;
          // A Run outside this Project (or deleted) answers 404; its rows show an error instead.
          return [runId, 'unavailable'];
        }
      }),
    );
    return new Map(entries) satisfies RunArtifactIndex;
  });
}

function DiffText({ segments, hidden }: { segments: TextDiffSegment[]; hidden: 'insert' | 'delete' }) {
  return (
    <>
      {segments
        .filter((segment) => segment.kind !== hidden)
        .map((segment, index) =>
          segment.kind === 'equal' ? (
            <Fragment key={index}>{segment.text}</Fragment>
          ) : (
            <mark key={index} className={`text-diff-${segment.kind}`}>
              {segment.text}
            </mark>
          ),
        )}
    </>
  );
}

type SampleAudio =
  | { kind: 'none' }
  | { kind: 'reference_error'; error: ArtifactReferenceError }
  | { kind: 'lookup_error' }
  | { kind: 'pending' }
  | { kind: 'run_unavailable' }
  | { kind: 'not_found' }
  | { kind: 'found'; artifact: Artifact };

function lookupSampleAudio(
  resolved: ArtifactReferenceResult | null,
  index: { value: RunArtifactIndex | undefined; error: string | null },
): SampleAudio {
  if (!resolved) return { kind: 'none' };
  if (!resolved.ok) return { kind: 'reference_error', error: resolved.error };
  if (index.error) return { kind: 'lookup_error' };
  const runArtifacts = index.value?.get(resolved.reference.runId);
  if (!runArtifacts) return { kind: 'pending' };
  if (runArtifacts === 'unavailable') return { kind: 'run_unavailable' };
  const artifact = runArtifacts.get(resolved.reference.path);
  return artifact ? { kind: 'found', artifact } : { kind: 'not_found' };
}

const sampleAudioMessages = {
  lookup_error: text.evaluationAudioLookupError,
  run_unavailable: text.evaluationAudioRunUnavailable,
  not_found: text.evaluationAudioNotFound,
} as const;

function AudioCell({
  source,
  audio,
  expanded,
  onToggle,
}: {
  source: string | null;
  audio: SampleAudio;
  expanded: boolean;
  onToggle: () => void;
}) {
  if (audio.kind === 'none') return <span className="muted">—</span>;
  if (audio.kind === 'pending') return <span className="muted">{text.loading}</span>;
  if (audio.kind === 'reference_error')
    return (
      <span className="sample-error" title={source ?? undefined}>
        {artifactReferenceErrorLabels[audio.error]}
      </span>
    );
  if (audio.kind !== 'found')
    return (
      <span className="sample-error" title={source ?? undefined}>
        {sampleAudioMessages[audio.kind]}
      </span>
    );
  return (
    <div className="sample-audio">
      {/* preload="none": a page of 50 rows must not download 50 files before anyone presses play. */}
      <audio
        controls
        preload="none"
        src={trackingApi.artifactUrl(audio.artifact.projectId, audio.artifact.id)}
        aria-label={source ?? undefined}
      />
      <button type="button" className="button small" aria-expanded={expanded} onClick={onToggle}>
        <AudioLines size={14} />
        {text.evaluationShowWaveform}
      </button>
    </div>
  );
}

export function EvaluationSamplesTable({ artifact, table }: { artifact: Artifact; table: EvaluationSampleTable }) {
  const [order, setOrder] = useState<EvaluationSampleOrder>('line');
  const [page, setPage] = useState(0);
  const [highlightDiff, setHighlightDiff] = useState(true);
  const [expandedLine, setExpandedLine] = useState<number | null>(null);
  const sorted = useMemo(() => sortEvaluationSamples(table.samples, order), [table.samples, order]);
  const current = paginate(sorted, page);
  const references = current.items.map((sample) =>
    sample.audio
      ? resolveArtifactReference(sample.audio, { projectId: artifact.projectId, tableRunId: artifact.runId })
      : null,
  );
  const runIds = Array.from(
    new Set(references.flatMap((result) => (result?.ok ? [result.reference.runId] : []))),
  ).sort();
  const artifactIndex = useRunArtifactIndex(artifact.projectId, runIds);
  const changePage = (next: number) => {
    setPage(next);
    setExpandedLine(null);
  };

  return (
    <div className="evaluation-samples">
      <div className="evaluation-samples-toolbar">
        <span>{artifactsTextTemplates.evaluationSampleCount(table.samples.length)}</span>
        {table.errors.length > 0 && (
          <span className="sample-error">{artifactsTextTemplates.evaluationBrokenRowCount(table.errors.length)}</span>
        )}
        <label className="audio-viewer-select">
          {text.sort}
          <select
            value={order}
            onChange={(event) => {
              setOrder(event.target.value as EvaluationSampleOrder);
              changePage(0);
            }}
          >
            <option value="line">{text.evaluationOrderLine}</option>
            <option value="score_asc">{text.evaluationOrderScoreAscending}</option>
            <option value="score_desc">{text.evaluationOrderScoreDescending}</option>
          </select>
        </label>
        <label className="evaluation-toggle">
          <input type="checkbox" checked={highlightDiff} onChange={(event) => setHighlightDiff(event.target.checked)} />
          {text.evaluationHighlightDiff}
        </label>
      </div>
      {table.errors.length > 0 && (
        <details className="evaluation-errors">
          <summary>{text.evaluationBrokenRows}</summary>
          <ul>
            {table.errors.slice(0, LISTED_ERROR_LIMIT).map((error) => (
              <li key={error.line}>
                {artifactsTextTemplates.evaluationLine(error.line)}: {evaluationSampleErrorLabels[error.reason]}
              </li>
            ))}
          </ul>
        </details>
      )}
      <ErrorNotice message={artifactIndex.error} retry={artifactIndex.reload} />
      <div className="table-scroll">
        <table className="evaluation-samples-table">
          <thead>
            <tr>
              <th scope="col">{text.evaluationLineColumn}</th>
              <th scope="col">audio</th>
              <th scope="col">reference</th>
              <th scope="col">prediction</th>
              <th scope="col">score</th>
            </tr>
          </thead>
          <tbody>
            {current.items.map((sample, rowIndex) => {
              const segments =
                highlightDiff && sample.reference !== null && sample.prediction !== null
                  ? diffCharacters(sample.reference, sample.prediction)
                  : null;
              const audio = lookupSampleAudio(references[rowIndex] ?? null, artifactIndex);
              const expanded = expandedLine === sample.line;
              return (
                <Fragment key={sample.line}>
                  <tr>
                    <td className="mono">{sample.line}</td>
                    <td>
                      <AudioCell
                        source={sample.audio}
                        audio={audio}
                        expanded={expanded}
                        onToggle={() => setExpandedLine(expanded ? null : sample.line)}
                      />
                    </td>
                    <td className="sample-text">
                      {segments ? <DiffText segments={segments} hidden="insert" /> : sample.reference ?? '—'}
                    </td>
                    <td className="sample-text">
                      {segments ? <DiffText segments={segments} hidden="delete" /> : sample.prediction ?? '—'}
                    </td>
                    <td className="mono">{sample.score === null ? '—' : formatValue(sample.score)}</td>
                  </tr>
                  {expanded && audio.kind === 'found' && (
                    <tr className="evaluation-sample-detail">
                      <td colSpan={5}>
                        <AudioArtifactViewer artifact={audio.artifact} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      {current.pageCount > 1 && (
        <nav className="section-actions evaluation-pagination" aria-label={text.evaluationPagination}>
          <button type="button" className="button small" disabled={current.page === 0} onClick={() => changePage(current.page - 1)}>
            {text.previousPage}
          </button>
          <span>{artifactsTextTemplates.evaluationPage(current.page + 1, current.pageCount)}</span>
          <button
            type="button"
            className="button small"
            disabled={current.page + 1 >= current.pageCount}
            onClick={() => changePage(current.page + 1)}
          >
            {text.nextPage}
          </button>
        </nav>
      )}
    </div>
  );
}
