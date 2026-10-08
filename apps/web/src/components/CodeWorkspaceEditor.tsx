import { lazy, Suspense, useState } from 'react';
import { ChevronDown, ChevronRight, Plus, Trash2 } from 'lucide-react';
import type { useCodeWorkspace } from '../hooks/useCodeWorkspace';
import type { CodeSample } from '../types/codeSample';
import { CODE_SAMPLES } from '../lib/codeSamples';
import { narrowerThan } from '../lib/breakpoints';
import { useMediaQuery } from '../lib/useMediaQuery';
import { CodeFileTree } from './CodeFileTree';
import { ErrorBoundary } from './ErrorBoundary';
import { ErrorNotice } from './Feedback';
import { text } from '../i18n/catalog';

const MonacoCodeEditor = lazy(() => import('./MonacoCodeEditor'));

export function CodeWorkspaceEditor({ editor, isGit, disabled, sampleId, onSampleChange, onApplySample }: {
  editor: ReturnType<typeof useCodeWorkspace>; isGit: boolean; disabled: boolean;
  sampleId: CodeSample['id']; onSampleChange: (id: CodeSample['id']) => void;
  onApplySample: () => void;
}) {
  // Below --bp-md the file list folds away so that Monaco keeps the dialog's full width.
  const isNarrow = useMediaQuery(narrowerThan('md'));
  const [isFileListOpen, setFileListOpen] = useState(false);
  const fileTree = <CodeFileTree paths={editor.paths} activePath={editor.activePath}
    onSelect={(path) => { editor.selectPath(path); setFileListOpen(false); }} />;
  return (
    <section className="code-workspace" data-testid="code-workspace">
      <div className="workspace-toolbar">
        {isGit && <button type="button" className="button" disabled={disabled}
          onClick={() => void editor.loadRepository()} data-testid="repository-load">
          {editor.pending ? text.loading : text.loadRepository}
        </button>}
        <label className="inline-selector"><span>{text.samples}</span>
          <select aria-label={text.samples} value={sampleId} disabled={disabled}
            onChange={(event) => onSampleChange(event.target.value as CodeSample['id'])}>
            {CODE_SAMPLES.map((sample) => <option key={sample.id} value={sample.id}>{sample.label}</option>)}
          </select>
        </label>
        <button type="button" className="button" disabled={disabled} onClick={onApplySample}>
          {text.applySample}
        </button>
      </div>
      <ErrorNotice message={editor.error} />
      <div className="workspace-toolbar">
        <label className="file-path-field"><span className="sr-only">{text.filePath}</span>
          <input aria-label={text.filePath} value={editor.newPath} placeholder={text.filePathPlaceholder}
            disabled={disabled} onChange={(event) => editor.setNewPath(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); editor.addFile(); } }} />
        </label>
        <button type="button" className="button small" onClick={editor.addFile} disabled={disabled || !editor.newPath.trim()}>
          <Plus size={14} />{text.newFile}
        </button>
        <button type="button" className="icon-button" aria-label={text.deleteFile}
          disabled={disabled || !editor.activePath} onClick={editor.deleteFile}><Trash2 size={15} /></button>
      </div>
      {editor.paths.length ? (
        <div className={isNarrow ? 'workspace-editor-grid narrow' : 'workspace-editor-grid'}>
          {!isNarrow && fileTree}
          <div className="workspace-editor-pane">
            {isNarrow ? (
              <button type="button" className="editor-file-header file-list-toggle mono" data-testid="active-file"
                aria-expanded={isFileListOpen} onClick={() => setFileListOpen((open) => !open)}
                aria-label={`${isFileListOpen ? text.hideFileList : text.showFileList}: ${editor.activePath}`}>
                {isFileListOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                <span>{editor.activePath}</span>
                <span className="muted">{editor.paths.length}</span>
              </button>
            ) : <div className="editor-file-header mono" data-testid="active-file">{editor.activePath}</div>}
            {isNarrow && isFileListOpen && fileTree}
            <div className="monaco-container" data-testid="monaco-editor">
              <ErrorBoundary><Suspense fallback={<p role="status">{text.loading}</p>}>
                <MonacoCodeEditor path={editor.activePath} value={editor.workspace.files[editor.activePath] ?? ''}
                  onChange={editor.updateFile} readOnly={disabled} />
              </Suspense></ErrorBoundary>
            </div>
          </div>
        </div>
      ) : <p className="muted">{text.noFiles}</p>}
      {isGit && editor.workspace.loadedRepository && <p className="muted" role="status">{text.repositoryLoaded}</p>}
      {isGit && editor.workspace.deletedFiles.length > 0 && <div className="deleted-files">
        <h3>{text.deletedFiles}</h3>
        {editor.workspace.deletedFiles.map((path) => <div key={path}><code>{path}</code>
          <button type="button" className="link-button" disabled={disabled} onClick={() => editor.restoreFile(path)}>
            {text.restoreFile}
          </button></div>)}
      </div>}
      {isGit && editor.workspace.omittedPaths.length > 0 && <details>
        <summary>{text.repositoryOmitted} ({editor.workspace.omittedPaths.length})</summary>
        <p className="muted">{text.repositoryOmittedHint}</p>
        <pre>{editor.workspace.omittedPaths.join('\n')}</pre>
      </details>}
    </section>
  );
}
