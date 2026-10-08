import { useId, useState } from 'react';
import { MoreHorizontal } from 'lucide-react';
import type { Artifact } from '@mmt/contracts';
import { artifactLifecycleApi } from '../api/artifactLifecycle';
import { usePopover } from '../hooks/usePopover';
import { ConfirmDialog } from './ConfirmDialog';
import { text, textTemplates } from '../i18n/catalog';

/**
 * The ⋯ menu of an open Artifact. Deletion sits here rather than as a standing button and always
 * asks first, because it cannot be undone. Render it only for Project admins.
 */
export function ArtifactActionsMenu({
  artifact,
  onDeleted,
}: {
  artifact: Artifact;
  onDeleted: () => void;
}) {
  const menuId = useId();
  const popover = usePopover();
  const [isConfirming, setIsConfirming] = useState(false);
  return (
    <div className="artifact-actions" ref={popover.container}>
      <button
        type="button"
        className="icon-button"
        aria-label={text.artifactActions}
        title={text.artifactActions}
        aria-haspopup="menu"
        aria-expanded={popover.isOpen}
        aria-controls={menuId}
        onClick={popover.toggle}
      >
        <MoreHorizontal size={17} />
      </button>
      {popover.isOpen && (
        <div className="artifact-actions-popover" id={menuId} role="menu">
          <button
            type="button"
            role="menuitem"
            className="danger"
            onClick={() => {
              popover.close();
              setIsConfirming(true);
            }}
          >
            {text.artifactDelete}
          </button>
        </div>
      )}
      {isConfirming && (
        <ConfirmDialog
          title={text.artifactDeleteTitle}
          message={textTemplates.artifactDeleteConfirm(artifact.path)}
          confirmLabel={text.artifactDelete}
          destructive
          onConfirm={() => artifactLifecycleApi.delete(artifact.projectId, artifact.id)}
          onConfirmed={() => {
            setIsConfirming(false);
            onDeleted();
          }}
          onClose={() => setIsConfirming(false)}
        />
      )}
    </div>
  );
}
