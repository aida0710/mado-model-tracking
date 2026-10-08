import { useId, useState } from 'react';
import { Tabs } from '../Tabs';
import { MarkdownView } from './MarkdownView';
import { text, textTemplates } from '../../i18n/catalog';

type MarkdownEditorTab = 'write' | 'preview';

/**
 * A Markdown textarea with a preview tab and the characters left before maxLength. Input over
 * the limit is kept so nothing typed is lost; the caller stops saving it.
 */
export function MarkdownEditor({
  label,
  value,
  onChange,
  maxLength,
  placeholder,
  rows = 8,
  autoFocus = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  maxLength: number;
  placeholder?: string;
  rows?: number;
  autoFocus?: boolean;
}) {
  const id = useId();
  const [tab, setTab] = useState<MarkdownEditorTab>('write');
  // Counts UTF-16 code units, the same unit the API's length check uses.
  const remaining = maxLength - value.length;
  return (
    <div className="markdown-editor">
      <Tabs
        tabs={[
          { key: 'write', label: text.markdownWrite },
          { key: 'preview', label: text.markdownPreview },
        ]}
        selected={tab}
        onSelect={(key) => setTab(key === 'preview' ? 'preview' : 'write')}
        panelId={`${id}-panel`}
      />
      <div id={`${id}-panel`} role="tabpanel" aria-label={label}>
        {tab === 'write' ? (
          <textarea
            aria-label={label}
            aria-describedby={`${id}-count`}
            value={value}
            rows={rows}
            placeholder={placeholder}
            autoFocus={autoFocus}
            onChange={(event) => onChange(event.target.value)}
          />
        ) : value.trim() ? (
          <div className="markdown-editor-preview">
            <MarkdownView source={value} />
          </div>
        ) : (
          <p className="markdown-editor-preview muted">{text.markdownPreviewEmpty}</p>
        )}
      </div>
      <div className="markdown-editor-footer">
        <span className="muted">{text.markdownHint}</span>
        <span
          id={`${id}-count`}
          className={remaining < 0 ? 'markdown-editor-count over' : 'markdown-editor-count'}
          aria-live="polite"
        >
          {textTemplates.markdownRemaining(remaining)}
        </span>
      </div>
    </div>
  );
}
