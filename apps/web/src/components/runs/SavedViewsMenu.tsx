import { useRef, useState } from 'react';
import { Bookmark, Check, Link2, Pencil, Save, Trash2 } from 'lucide-react';
import type { SavedView, SavedViewState } from '@mmt/contracts';
import { savedViewsApi } from '../../api/savedViews';
import { ConfirmDialog } from '../ConfirmDialog';
import { ErrorNotice } from '../Feedback';
import { SaveViewDialog } from './SaveViewDialog';
import { useMutation } from '../../hooks/useMutation';
import type { QueryState } from '../../hooks/useQuery';
import {
  canChangeSavedView,
  canChangeSavedViewVisibility,
  canDeleteSavedView,
  savedViewVisibilityChoices,
  type SavedViewActor,
} from '../../lib/savedViewPermissions';
import { text, textTemplates } from '../../i18n/catalog';

type MenuDialog = 'saveAs' | 'rename' | 'delete' | null;

/**
 * The saved views of the Run list: open one, save the shown list over it or under a new name,
 * rename, delete and copy its URL. The page owns what "the shown list" is (`readCurrentState`).
 */
export function SavedViewsMenu({
  projectId,
  actor,
  views,
  activeView,
  hasUnsavedChanges,
  readCurrentState,
  viewUrl,
  onOpen,
  onSaved,
  onDeleted,
}: {
  projectId: string;
  actor: SavedViewActor;
  views: QueryState<SavedView[]>;
  activeView: SavedView | null;
  hasUnsavedChanges: boolean;
  readCurrentState: () => SavedViewState;
  viewUrl: (viewId: string) => string;
  /** null opens the default display. */
  onOpen: (viewId: string | null) => void;
  onSaved: (view: SavedView) => void;
  onDeleted: (view: SavedView) => void;
}) {
  const menuRef = useRef<HTMLDetailsElement>(null);
  const [dialog, setDialog] = useState<MenuDialog>(null);
  const [isUrlCopied, setIsUrlCopied] = useState(false);
  const mutation = useMutation();
  const items = views.value ?? [];
  const groups = [
    { label: text.savedViewPrivateGroup, items: items.filter((view) => view.visibility === 'private') },
    { label: text.savedViewProjectGroup, items: items.filter((view) => view.visibility === 'project') },
  ].filter((group) => group.items.length);

  function open(viewId: string | null) {
    if (menuRef.current) menuRef.current.open = false;
    setIsUrlCopied(false);
    onOpen(viewId);
  }
  async function overwrite(view: SavedView) {
    const saved = await mutation.run(() =>
      savedViewsApi.update(projectId, view.id, { state: readCurrentState() }),
    );
    if (saved) finishSave(saved);
  }
  function finishSave(saved: SavedView) {
    setDialog(null);
    views.reload();
    onSaved(saved);
  }
  async function copyUrl(view: SavedView) {
    const copied = await mutation.run(async () => {
      if (!navigator.clipboard) throw new Error(text.copyFailed);
      await navigator.clipboard.writeText(viewUrl(view.id));
      return true;
    });
    setIsUrlCopied(Boolean(copied));
  }

  const canChange = activeView ? canChangeSavedView(activeView, actor) : false;
  return (
    <div className="saved-views-bar">
      <details className="saved-views-menu" ref={menuRef}>
        <summary>
          <Bookmark size={14} />
          {activeView ? textTemplates.savedViewCurrent(activeView.name) : text.savedViewDefault}
        </summary>
        <div className="popover" role="menu" aria-label={text.savedViews}>
          <button
            type="button"
            role="menuitemradio"
            aria-checked={!activeView}
            onClick={() => open(null)}
          >
            {!activeView && <Check size={13} />}
            {text.savedViewDefault}
          </button>
          <ErrorNotice message={views.error} retry={views.reload} />
          {views.value && !items.length && <p className="muted">{text.savedViewNone}</p>}
          {groups.map((group) => (
            <div key={group.label} role="group" aria-label={group.label}>
              <small>{group.label}</small>
              {group.items.map((view) => (
                <button
                  key={view.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={activeView?.id === view.id}
                  onClick={() => open(view.id)}
                >
                  {activeView?.id === view.id && <Check size={13} />}
                  {view.name}
                </button>
              ))}
            </div>
          ))}
        </div>
      </details>
      {activeView?.visibility === 'project' && (
        <span className="saved-view-tag">{text.savedViewShared}</span>
      )}
      {activeView && hasUnsavedChanges && (
        <span className="saved-view-unsaved" role="status">
          {text.savedViewUnsaved}
        </span>
      )}
      {activeView && canChange && hasUnsavedChanges && (
        <button
          type="button"
          className="button small"
          disabled={mutation.pending}
          onClick={() => void overwrite(activeView)}
        >
          <Save size={13} />
          {text.savedViewSave}
        </button>
      )}
      <button type="button" className="button small" onClick={() => setDialog('saveAs')}>
        {text.savedViewSaveAs}
      </button>
      {activeView && (
        <>
          <button type="button" className="button small" onClick={() => void copyUrl(activeView)}>
            <Link2 size={13} />
            {isUrlCopied ? text.savedViewUrlCopied : text.savedViewCopyUrl}
          </button>
          {canChange && (
            <button type="button" className="button small" onClick={() => setDialog('rename')}>
              <Pencil size={13} />
              {text.savedViewRename}
            </button>
          )}
          {canDeleteSavedView(activeView, actor) && (
            <button type="button" className="button small" onClick={() => setDialog('delete')}>
              <Trash2 size={13} />
              {text.savedViewDelete}
            </button>
          )}
        </>
      )}
      <ErrorNotice message={mutation.error} />
      {dialog === 'saveAs' && (
        <SaveViewDialog
          title={text.savedViewSaveAs}
          initialName=""
          initialVisibility="private"
          visibilityChoices={savedViewVisibilityChoices(actor.role)}
          onSubmit={({ name, visibility }) =>
            savedViewsApi.create(projectId, { page: 'runs', name, visibility, state: readCurrentState() })
          }
          onSaved={finishSave}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'rename' && activeView && (
        <SaveViewDialog
          title={text.savedViewRename}
          initialName={activeView.name}
          initialVisibility={activeView.visibility}
          visibilityChoices={
            canChangeSavedViewVisibility(activeView, actor)
              ? savedViewVisibilityChoices(actor.role)
              : []
          }
          onSubmit={({ name, visibility }) =>
            savedViewsApi.update(projectId, activeView.id, {
              name,
              ...(visibility === activeView.visibility ? {} : { visibility }),
            })
          }
          onSaved={finishSave}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'delete' && activeView && (
        <ConfirmDialog
          title={text.savedViewDeleteTitle}
          message={textTemplates.savedViewDeleteMessage(activeView.name)}
          confirmLabel={text.savedViewDelete}
          destructive
          onConfirm={() => savedViewsApi.remove(projectId, activeView.id)}
          onConfirmed={() => {
            setDialog(null);
            views.reload();
            onDeleted(activeView);
          }}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
}
