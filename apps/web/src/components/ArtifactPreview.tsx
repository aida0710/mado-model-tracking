import type { Artifact } from '@mmt/contracts';
import { artifactMediaKind } from '../lib/artifactMediaKind';
import { evaluationSampleFormat } from '../lib/evaluationSamples';
import { text } from '../i18n/catalog';
import { AudioArtifactViewer } from './preview/AudioArtifactViewer';
import { EvaluationSamplesPreview } from './preview/EvaluationSamplesPreview';
import { ImagePreview } from './preview/ImagePreview';
import { TextPreview } from './preview/TextPreview';
import { VideoPreview } from './preview/VideoPreview';

/** Chooses the preview for an Artifact's media kind; each kind lives in components/preview/. */
export function ArtifactPreview({ artifact }: { artifact: Artifact }) {
  const mediaKind = artifactMediaKind(artifact.mimeType);
  const tableFormat = evaluationSampleFormat(artifact.path, artifact.mimeType);
  if (mediaKind === 'text' && tableFormat) return <EvaluationSamplesPreview artifact={artifact} format={tableFormat} />;
  if (mediaKind === 'text') return <TextPreview artifact={artifact} />;
  if (mediaKind === 'image') return <ImagePreview artifact={artifact} />;
  if (mediaKind === 'audio') return <AudioArtifactViewer artifact={artifact} />;
  if (mediaKind === 'video') return <VideoPreview artifact={artifact} />;
  return <p className="muted">{text.previewUnsupported}</p>;
}
