import { ChevronLeft } from 'lucide-react';
import { text } from '../i18n/catalog';

/** On a narrow screen the preview covers the file list; this returns to it. */
export function ArtifactBackToListButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" className="button artifact-back-to-list" onClick={onClick}>
      <ChevronLeft size={16} aria-hidden="true" />
      {text.artifactBackToList}
    </button>
  );
}
