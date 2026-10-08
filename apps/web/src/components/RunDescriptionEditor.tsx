import { useState } from 'react';
import { Pencil } from 'lucide-react';
import { RUN_NOTE_MAX_LENGTH, RUN_NOTE_TAG } from '@mmt/contracts';
import type { RunDescriptionEditorProps } from './charts/chartProps';
import { runNotesApi } from '../api/runNotes';
import { useMutation } from '../hooks/useMutation';
import { useProject } from '../hooks/useProject';
import { useUnsavedChanges } from '../hooks/useUnsavedChanges';
import { MarkdownEditor } from './markdown/MarkdownEditor';
import { MarkdownView } from './markdown/MarkdownView';
import { Empty, ErrorNotice } from './Feedback';
import { UnsavedChangesDialog } from './UnsavedChangesDialog';
import { text } from '../i18n/catalog';

/**
 * The Run's Markdown description. It is the MLflow tag mlflow.note.content, so a description
 * written from an MLflow client shows here and one saved here is what MLflow reads.
 */
export function RunDescriptionEditor({ projectId, run }: RunDescriptionEditorProps) {
  const { canEdit } = useProject();
  const runContent = run.tags[RUN_NOTE_TAG] ?? '';
  // What this screen saved, remembered against the tag value it replaced. Once the page reads the
  // Run again, the tag itself is the newer answer.
  const [saved, setSaved] = useState<{ replacedContent: string; content: string } | null>(null);
  const content = saved && saved.replacedContent === runContent ? saved.content : runContent;
  const [isEditing, setIsEditing] = useState(false);
  return (
    <section className="run-description">
      <div className="run-description-header">
        <h2>{text.runDescription}</h2>
        {canEdit && !isEditing && (
          <button type="button" className="button small" onClick={() => setIsEditing(true)}>
            <Pencil size={14} />
            {text.runDescriptionEdit}
          </button>
        )}
      </div>
      {isEditing ? (
        <RunDescriptionForm
          initialContent={content}
          save={(nextContent) => runNotesApi.update(projectId, run.id, { content: nextContent })}
          onSaved={(nextContent) => {
            setSaved({ replacedContent: runContent, content: nextContent });
            setIsEditing(false);
          }}
          onClose={() => setIsEditing(false)}
        />
      ) : content.trim() ? (
        <MarkdownView source={content} />
      ) : (
        <Empty>{text.runDescriptionEmpty}</Empty>
      )}
    </section>
  );
}

function RunDescriptionForm({
  initialContent,
  save,
  onSaved,
  onClose,
}: {
  initialContent: string;
  save: (content: string) => Promise<{ content: string }>;
  onSaved: (content: string) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(initialContent);
  const mutation = useMutation();
  const isOverLimit = draft.length > RUN_NOTE_MAX_LENGTH;
  const unsaved = useUnsavedChanges(draft !== initialContent, mutation.pending, {
    onNavigationDiscard: onClose,
  });
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        // The API would answer 422; stopping here keeps the draft and says why.
        if (isOverLimit) return;
        void mutation.run(() => save(draft)).then((note) => {
          if (note) onSaved(note.content);
        });
      }}
    >
      <MarkdownEditor
        label={text.runDescription}
        value={draft}
        onChange={setDraft}
        maxLength={RUN_NOTE_MAX_LENGTH}
        placeholder={text.runDescriptionPlaceholder}
        autoFocus
      />
      <ErrorNotice message={mutation.error} />
      <div className="comment-editor-actions">
        <button
          type="button"
          className="button small"
          disabled={mutation.pending}
          onClick={() => unsaved.requestAction(onClose)}
        >
          {text.cancel}
        </button>
        <button className="button small primary" disabled={mutation.pending || isOverLimit}>
          {mutation.pending ? text.loading : text.save}
        </button>
      </div>
      {unsaved.confirmingDiscard && (
        <UnsavedChangesDialog onDiscard={unsaved.discard} onKeepEditing={unsaved.keepEditing} />
      )}
    </form>
  );
}
