import { useState } from 'react';
import { COMMENT_MAX_LENGTH } from '@mmt/contracts';
import { MarkdownEditor } from '../markdown/MarkdownEditor';
import { ErrorNotice } from '../Feedback';
import { useMutation } from '../../hooks/useMutation';
import { text } from '../../i18n/catalog';

/**
 * Writes a new comment, a reply or an edit. The body is checked against the API's rules
 * (not only whitespace, at most COMMENT_MAX_LENGTH) before it is sent.
 */
export function CommentEditor({
  label,
  submitLabel,
  initialBody = '',
  placeholder,
  autoFocus = false,
  onSubmit,
  onCancel,
}: {
  label: string;
  submitLabel: string;
  initialBody?: string;
  placeholder?: string;
  autoFocus?: boolean;
  onSubmit: (body: string) => Promise<unknown>;
  onCancel?: () => void;
}) {
  const [body, setBody] = useState(initialBody);
  const [showsRequired, setShowsRequired] = useState(false);
  const mutation = useMutation();
  const isOverLimit = body.length > COMMENT_MAX_LENGTH;
  return (
    <form
      className="comment-editor"
      onSubmit={(event) => {
        event.preventDefault();
        if (!body.trim()) {
          setShowsRequired(true);
          return;
        }
        if (isOverLimit) return;
        void mutation
          .run(async () => {
            await onSubmit(body);
            return true;
          })
          .then((isSaved) => {
            if (isSaved) setBody('');
          });
      }}
    >
      <MarkdownEditor
        label={label}
        value={body}
        onChange={(value) => {
          setBody(value);
          setShowsRequired(false);
        }}
        maxLength={COMMENT_MAX_LENGTH}
        placeholder={placeholder}
        rows={4}
        autoFocus={autoFocus}
      />
      <ErrorNotice message={showsRequired ? text.commentBodyRequired : mutation.error} />
      <div className="comment-editor-actions">
        {onCancel && (
          <button type="button" className="button small" onClick={onCancel} disabled={mutation.pending}>
            {text.cancel}
          </button>
        )}
        <button className="button small primary" disabled={mutation.pending || isOverLimit}>
          {mutation.pending ? text.loading : submitLabel}
        </button>
      </div>
    </form>
  );
}
