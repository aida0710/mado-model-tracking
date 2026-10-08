import { useMemo } from 'react';
import type { Artifact } from '@mmt/contracts';
import { trackingApi } from '../../api/tracking';
import { useQuery } from '../../hooks/useQuery';
import {
  isEvaluationSampleTable,
  parseEvaluationSamples,
  type EvaluationSampleFormat,
} from '../../lib/evaluationSamples';
import { Resource } from '../Feedback';
import { text } from '../../i18n/catalog';
import { EvaluationSamplesTable } from './EvaluationSamplesTable';
import { TEXT_PREVIEW_MAX_BYTES, TextContent } from './TextPreview';

/**
 * Evaluation results with thousands of rows are a few MB of jsonl. 16MiB keeps parsing on the main
 * thread under about a second; larger tables are downloaded instead.
 */
export const EVALUATION_SAMPLES_MAX_BYTES = 16 * 1024 * 1024;

function ParsedTable({ artifact, content, format }: { artifact: Artifact; content: string; format: EvaluationSampleFormat }) {
  const table = useMemo(() => parseEvaluationSamples(content, format), [content, format]);
  if (isEvaluationSampleTable(table.columns)) return <EvaluationSamplesTable artifact={artifact} table={table} />;
  if (artifact.size <= TEXT_PREVIEW_MAX_BYTES) return <TextContent content={content} />;
  return <p className="muted">{text.previewUnsupported}</p>;
}

/** jsonl / csv: an evaluation sample table when the columns match, plain text otherwise. */
export function EvaluationSamplesPreview({ artifact, format }: { artifact: Artifact; format: EvaluationSampleFormat }) {
  const canLoad = artifact.size <= EVALUATION_SAMPLES_MAX_BYTES;
  const content = useQuery(canLoad ? `${artifact.id}:text` : null, (signal) =>
    trackingApi.artifactText(artifact.projectId, artifact.id, signal),
  );
  if (!canLoad) return <p className="muted">{text.previewUnsupported}</p>;
  return (
    <Resource query={content}>
      {(value) => <ParsedTable artifact={artifact} content={value} format={format} />}
    </Resource>
  );
}
