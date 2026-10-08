import type { Artifact } from '@mmt/contracts';
import { trackingApi } from '../../api/tracking';
import { useQuery } from '../../hooks/useQuery';
import { Resource } from '../Feedback';
import { text } from '../../i18n/catalog';

// Text previews stay bounded; large files use the streaming download link.
export const TEXT_PREVIEW_MAX_BYTES = 1024 * 1024;

export function TextContent({ content }: { content: string }) {
  return <pre className="artifact-text">{content}</pre>;
}

export function TextPreview({ artifact }: { artifact: Artifact }) {
  const canPreview = artifact.size <= TEXT_PREVIEW_MAX_BYTES;
  const content = useQuery(canPreview ? `${artifact.id}:text` : null, (signal) =>
    trackingApi.artifactText(artifact.projectId, artifact.id, signal),
  );
  if (!canPreview) return <p className="muted">{text.previewUnsupported}</p>;
  return <Resource query={content}>{(value) => <TextContent content={value} />}</Resource>;
}
